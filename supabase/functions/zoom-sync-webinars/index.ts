// supabase/functions/zoom-sync-webinars/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.0';
// Import shared utilities - these will be copied during deployment
import { EdgeFunctionError, corsHeaders, createLogger, formatErrorResponse } from './shared/index.ts'; // Assuming shared/index.ts is in the same directory

// Business logic separated from infrastructure
class ZoomWebinarSyncService {
  adminClient;
  logger;

  constructor(adminClient, logger){
    this.adminClient = adminClient;
    this.logger = logger;
  }

  async validateConnection(connection) {
    if (!connection.access_token) {
      throw new EdgeFunctionError('No access token found. Please reconnect your Zoom account.', 400);
    }
    const tokenExpiresAt = new Date(connection.token_expires_at);
    const now = new Date();
    if (tokenExpiresAt < now) {
      throw new EdgeFunctionError('Zoom access token has expired. Please reconnect your account.', 401);
    }
  }

  async createSyncLog(connectionId, syncType) {
    const { data: syncLog, error } = await this.adminClient.from('zoom_sync_logs').insert({
      connection_id: connectionId,
      sync_type: syncType,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      total_items: 0,
      processed_items: 0
    }).select('id').single();

    if (error) {
      this.logger.error('Failed to create sync log', error);
      throw new EdgeFunctionError('Failed to initialize sync', 500, { error: error.message });
    }
    return syncLog.id;
  }

  async testZoomAPI(accessToken) {
    const response = await fetch('https://api.zoom.us/v2/users/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error('Zoom API test failed', { status: response.status, error: errorText });
      throw new EdgeFunctionError('Zoom API authentication failed. Please reconnect your account.', 401);
    }
    return response.json();
  }

  async fetchWebinars(accessToken) {
    const allWebinars = [];
    let nextPageToken = '';
    let pageCount = 0;
    const maxPages = 10; // Prevent infinite loops

    do {
      pageCount++;
      const url = `https://api.zoom.us/v2/users/me/webinars?page_size=300&type=scheduled,upcoming,past${nextPageToken ? `&next_page_token=${nextPageToken}` : ''}`;
      this.logger.info(`Fetching webinars page ${pageCount}`);
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new EdgeFunctionError(`Failed to fetch webinars: ${response.status}`, 500, { error: errorText });
      }
      const data = await response.json();
      if (data.webinars && data.webinars.length > 0) {
        allWebinars.push(...data.webinars);
      }
      nextPageToken = data.next_page_token || '';
    } while (nextPageToken && pageCount < maxPages);
    return allWebinars;
  }

  async saveWebinars(webinars, connectionId, syncLogId) {
    const batchSize = 50;
    let processedCount = 0;

    for(let i = 0; i < webinars.length; i += batchSize){
      const batch = webinars.slice(i, i + batchSize);
      const webinarsToInsert = batch.map((webinar)=>({
          connection_id: connectionId,
          webinar_id: webinar.id.toString(),
          webinar_uuid: webinar.uuid,
          host_id: webinar.host_id,
          topic: webinar.topic,
          type: webinar.type,
          start_time: webinar.start_time,
          duration: webinar.duration,
          timezone: webinar.timezone,
          agenda: webinar.agenda || '',
          status: this.mapWebinarStatus(webinar),
          join_url: webinar.join_url,
          registration_url: webinar.registration_url,
          last_synced_at: new Date().toISOString() // CORRECTED LINE
        }));

      const { error } = await this.adminClient.from('zoom_webinars').upsert(webinarsToInsert, {
        onConflict: 'connection_id,webinar_id',
        ignoreDuplicates: false
      });

      if (error) {
        throw new EdgeFunctionError(`Failed to save webinars: ${error.message}`, 500);
      }
      processedCount += batch.length;
      // Update progress
      await this.updateSyncProgress(syncLogId, processedCount);
    }
  }

  async updateSyncProgress(syncLogId, processedItems) {
    await this.adminClient.from('zoom_sync_logs').update({
      processed_items: processedItems
    }).eq('id', syncLogId);
  }

  async completeSyncLog(syncLogId, totalItems, status, error) {
    const update = {
      status,
      processed_items: totalItems,
      completed_at: new Date().toISOString(),
    };
    if (error) {
      update.error_message = error;
      update.error_details = { error };
    }
    await this.adminClient.from('zoom_sync_logs').update(update).eq('id', syncLogId);
  }

  mapWebinarStatus(webinar) {
    const now = new Date();
    const startTime = new Date(webinar.start_time);
    const endTime = new Date(startTime.getTime() + webinar.duration * 60 * 1000);

    if (now < startTime) {
      return 'scheduled';
    } else if (now >= startTime && now <= endTime) {
      return 'started';
    } else {
      return 'finished';
    }
  }
}

// Main handler
serve(async (req)=>{
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const logger = createLogger('zoom-sync-webinars');
  const requestId = logger.getRequestId();

  try {
    logger.info('Function started', { method: req.method, url: req.url });

    // Validate environment
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      throw new EdgeFunctionError('Missing required environment variables', 500);
    }

    // Get auth header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new EdgeFunctionError('Missing Authorization header', 401);
    }

    // Create authenticated clients
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      throw new EdgeFunctionError('Authentication failed', 401);
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    logger.info('User authenticated', { userId: user.id });

    // Parse request body
    let body;
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch (e) {
      throw new EdgeFunctionError('Invalid request body', 400);
    }

    // Validate request
    if (!body.connectionId) {
      throw new EdgeFunctionError('Missing connection ID', 400);
    }
    const syncType = body.syncType || 'incremental';

    // Get connection
    const { data: connection, error: connError } = await userClient
      .from('zoom_connections')
      .select('*')
      .eq('id', body.connectionId)
      .eq('user_id', user.id)
      .single();

    if (connError || !connection) {
      throw new EdgeFunctionError('Connection not found', 404);
    }
    logger.info('Connection found', { connectionId: connection.id, email: connection.zoom_email });

    // Initialize service
    const syncService = new ZoomWebinarSyncService(adminClient, logger);

    // Validate connection
    await syncService.validateConnection(connection);

    // Create sync log
    const syncLogId = await syncService.createSyncLog(connection.id, syncType);
    logger.info('Sync log created', { syncLogId });

    let totalWebinars = 0;
    try {
      // Test Zoom API
      const userData = await syncService.testZoomAPI(connection.access_token);
      logger.info('Zoom API test successful', { email: userData.email });

      // Fetch webinars
      const webinars = await syncService.fetchWebinars(connection.access_token);
      totalWebinars = webinars.length;
      logger.info('Webinars fetched', { count: totalWebinars });

      // Update total in sync log
      await adminClient.from('zoom_sync_logs').update({ total_items: totalWebinars }).eq('id', syncLogId);

      // Save webinars
      if (totalWebinars > 0) {
        await syncService.saveWebinars(webinars, connection.id, syncLogId);
      }

      // Complete sync
      await syncService.completeSyncLog(syncLogId, totalWebinars, 'completed');

      return new Response(JSON.stringify({
        success: true,
        syncId: syncLogId,
        data: {
          syncId: syncLogId,
          status: 'completed',
          message: `Successfully synced ${totalWebinars} webinars`,
          totalItems: totalWebinars,
          processedItems: totalWebinars,
        },
        requestId,
      }), { headers: corsHeaders });

    } catch (error) {
      // Update sync log with failure
      await syncService.completeSyncLog(syncLogId, totalWebinars, 'failed', error.message);
      throw error; // Re-throw to be caught by outer try-catch
    }

  } catch (error) {
    logger.error('Function failed', error);
    const errorResponse = formatErrorResponse(error, requestId);
    return new Response(JSON.stringify({
      success: false,
      error: errorResponse.error,
      requestId,
    }), {
      status: errorResponse.statusCode || 500,
      headers: corsHeaders,
    });
  }
});
