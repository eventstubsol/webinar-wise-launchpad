import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "./cors.ts";
import { SimpleTokenEncryption } from "./encryption.ts";

// Types
interface SyncRequest {
  connectionId: string;
  syncMode?: 'full' | 'delta' | 'smart';
  dateRange?: {
    pastDays?: number;
    futureDays?: number;
  };
  resumeSyncId?: string;
}

interface WebinarQueueItem {
  webinar_id: string;
  webinar_type: 'past' | 'upcoming';
  priority?: number;
}

// Rate Limit Manager
class RateLimitManager {
  private callsPerMinute = 0;
  private callsPerSecond = 0;
  private windowStart = Date.now();
  private secondWindowStart = Date.now();
  private readonly MAX_CALLS_PER_MINUTE = 30;
  private readonly MAX_CALLS_PER_SECOND = 2;
  private retryAfter = 0;

  async executeWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForRateLimit();
    
    try {
      const result = await fn();
      this.recordCall();
      return result;
    } catch (error: any) {
      if (error.status === 429) {
        // Handle rate limit error
        const retryAfter = parseInt(error.headers?.['retry-after'] || '60');
        this.retryAfter = Date.now() + (retryAfter * 1000);
        
        // Wait and retry
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        return this.executeWithRateLimit(fn);
      }
      throw error;
    }
  }

  private async waitForRateLimit() {
    // Check if we're in a retry-after period
    if (this.retryAfter > Date.now()) {
      const waitTime = this.retryAfter - Date.now();
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return;
    }

    // Reset windows if needed
    const now = Date.now();
    if (now - this.windowStart > 60000) {
      this.callsPerMinute = 0;
      this.windowStart = now;
    }
    if (now - this.secondWindowStart > 1000) {
      this.callsPerSecond = 0;
      this.secondWindowStart = now;
    }

    // Wait if at per-second limit
    if (this.callsPerSecond >= this.MAX_CALLS_PER_SECOND) {
      const waitTime = 1000 - (now - this.secondWindowStart);
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
        this.callsPerSecond = 0;
        this.secondWindowStart = Date.now();
      }
    }

    // Wait if at per-minute limit
    if (this.callsPerMinute >= this.MAX_CALLS_PER_MINUTE) {
      const waitTime = 60000 - (now - this.windowStart);
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
        this.callsPerMinute = 0;
        this.windowStart = Date.now();
      }
    }
  }

  private recordCall() {
    this.callsPerMinute++;
    this.callsPerSecond++;
  }
}

// Progress broadcaster
async function broadcastProgress(
  supabase: any,
  syncId: string,
  type: string,
  message: string,
  details?: any,
  percentage?: number
) {
  try {
    await supabase.from('sync_progress_updates').insert({
      sync_id: syncId,
      update_type: type,
      message,
      details: details || {},
      progress_percentage: percentage
    });
  } catch (error) {
    console.error('Failed to broadcast progress:', error);
  }
}

// Get Zoom access token
async function getZoomAccessToken(supabase: any, connectionId: string): Promise<string> {
  const { data: connection, error } = await supabase
    .from('zoom_connections')
    .select('access_token, refresh_token, token_expires_at, zoom_email')
    .eq('id', connectionId)
    .single();

  if (error || !connection) {
    throw new Error('Connection not found');
  }

  // Decrypt the current access token
  let decryptedToken: string;
  try {
    decryptedToken = await SimpleTokenEncryption.decryptToken(
      connection.access_token,
      connection.zoom_email
    );
  } catch (error) {
    console.error('Failed to decrypt access token:', error);
    throw new Error('Failed to decrypt access token');
  }

  // Check if token needs refresh
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  if (expiresAt <= fiveMinutesFromNow) {
    // Token expired or expiring soon, refresh it
    const refreshResponse = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${Deno.env.get('ZOOM_CLIENT_ID')}:${Deno.env.get('ZOOM_CLIENT_SECRET')}`)}`
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: connection.refresh_token
      })
    });

    if (!refreshResponse.ok) {
      throw new Error('Failed to refresh token');
    }

    const tokens = await refreshResponse.json();
    
    // Encrypt the new access token
    const encryptedAccessToken = await SimpleTokenEncryption.encryptToken(
      tokens.access_token,
      connection.zoom_email
    );
    
    // Update tokens in database
    await supabase
      .from('zoom_connections')
      .update({
        access_token: encryptedAccessToken,
        refresh_token: tokens.refresh_token,
        token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      })
      .eq('id', connectionId);

    return tokens.access_token;
  }

  return decryptedToken;
}

// Fetch webinar list with pagination
async function fetchWebinarList(
  accessToken: string,
  type: 'past' | 'upcoming',
  dateRange: { from?: string; to?: string },
  pageSize = 100,
  nextPageToken?: string
): Promise<{ webinars: any[]; nextPageToken?: string }> {
  const params = new URLSearchParams({
    type: type === 'past' ? 'past' : 'scheduled',
    page_size: pageSize.toString(),
    ...(nextPageToken && { next_page_token: nextPageToken }),
    ...(dateRange.from && { from: dateRange.from }),
    ...(dateRange.to && { to: dateRange.to })
  });

  console.log(`[SYNC] Fetching ${type} webinars with params:`, params.toString());

  const response = await fetch(`https://api.zoom.us/v2/users/me/webinars?${params}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch webinar list: ${error}`);
  }

  const data = await response.json();
  console.log(`[SYNC] Fetched ${data.webinars?.length || 0} ${type} webinars from page`);
  
  return {
    webinars: data.webinars || [],
    nextPageToken: data.next_page_token
  };
}

// Determine webinar status based on type and time
function determineWebinarStatus(webinarDetails: any, webinarType: 'past' | 'upcoming'): string {
  console.log(`[SYNC] Determining status for webinar ${webinarDetails.id}, type: ${webinarType}, API status: ${webinarDetails.status}`);
  
  // If it's a past webinar, it should always be finished
  if (webinarType === 'past') {
    console.log(`[SYNC] Setting status to 'finished' because webinar type is 'past'`);
    return 'finished';
  }
  
  // Check if start_time is in the past
  if (webinarDetails.start_time) {
    const startTime = new Date(webinarDetails.start_time);
    const now = new Date();
    
    if (startTime < now) {
      console.log(`[SYNC] Setting status to 'finished' because start_time (${startTime}) is in the past`);
      return 'finished';
    }
  }
  
  // Use API status if provided and valid
  if (webinarDetails.status) {
    const validStatuses = ['waiting', 'started', 'finished', 'scheduled'];
    if (validStatuses.includes(webinarDetails.status)) {
      console.log(`[SYNC] Using API status: ${webinarDetails.status}`);
      return webinarDetails.status;
    }
  }
  
  // Default to scheduled for upcoming webinars
  console.log(`[SYNC] Defaulting to 'scheduled' status`);
  return 'scheduled';
}

// Fetch complete webinar details
async function fetchWebinarDetails(
  accessToken: string,
  webinarId: string,
  type: 'past' | 'upcoming'
): Promise<any> {
  const endpoint = type === 'past' 
    ? `https://api.zoom.us/v2/past_webinars/${webinarId}`
    : `https://api.zoom.us/v2/webinars/${webinarId}`;

  console.log(`[SYNC] Fetching details for ${type} webinar ${webinarId}`);

  const response = await fetch(endpoint, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`[SYNC] Failed to fetch webinar details for ${webinarId}: ${error}`);
    throw new Error(`Failed to fetch webinar details: ${error}`);
  }

  const data = await response.json();
  console.log(`[SYNC] Successfully fetched details for webinar ${webinarId}: ${data.topic}`);
  
  // Log which fields are missing
  const missingFields = [];
  if (!data.host_email) missingFields.push('host_email');
  if (!data.registrants_count && data.registrants_count !== 0) missingFields.push('registrants_count');
  if (!data.participants_count && data.participants_count !== 0) missingFields.push('participants_count');
  if (!data.settings) missingFields.push('settings');
  
  if (missingFields.length > 0) {
    console.log(`[SYNC] Missing data fields for webinar ${webinarId}: ${missingFields.join(', ')}`);
  }
  
  return data;
}

// Fetch registrant count for a webinar
async function fetchRegistrantCount(
  accessToken: string,
  webinarId: string,
  rateLimiter: RateLimitManager
): Promise<number> {
  try {
    console.log(`[SYNC] Fetching registrant count for webinar ${webinarId}`);
    
    const response = await rateLimiter.executeWithRateLimit(async () => {
      return await fetch(`https://api.zoom.us/v2/webinars/${webinarId}/registrants?page_size=1`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
    });

    if (response.ok) {
      const data = await response.json();
      const count = data.total_records || 0;
      console.log(`[SYNC] Found ${count} registrants for webinar ${webinarId}`);
      return count;
    }
    
    console.log(`[SYNC] Could not fetch registrant count for webinar ${webinarId}`);
    return 0;
  } catch (error) {
    console.error(`[SYNC] Error fetching registrant count for ${webinarId}:`, error);
    return 0;
  }
}

// Fetch participant/attendee data for past webinars
async function fetchParticipantData(
  accessToken: string,
  webinarId: string,
  rateLimiter: RateLimitManager
): Promise<{ count: number; avgDuration: number }> {
  try {
    console.log(`[SYNC] Fetching participant data for webinar ${webinarId}`);
    
    const response = await rateLimiter.executeWithRateLimit(async () => {
      return await fetch(`https://api.zoom.us/v2/past_webinars/${webinarId}/participants?page_size=300`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
    });

    if (response.ok) {
      const data = await response.json();
      const participants = data.participants || [];
      const count = data.total_records || participants.length;
      
      // Calculate average duration
      let totalDuration = 0;
      let validParticipants = 0;
      
      participants.forEach((p: any) => {
        if (p.duration && p.duration > 0) {
          totalDuration += p.duration;
          validParticipants++;
        }
      });
      
      const avgDuration = validParticipants > 0 ? Math.round(totalDuration / validParticipants) : 0;
      
      console.log(`[SYNC] Found ${count} participants with avg duration ${avgDuration} seconds for webinar ${webinarId}`);
      return { count, avgDuration };
    }
    
    console.log(`[SYNC] Could not fetch participant data for webinar ${webinarId}`);
    return { count: 0, avgDuration: 0 };
  } catch (error) {
    console.error(`[SYNC] Error fetching participant data for ${webinarId}:`, error);
    return { count: 0, avgDuration: 0 };
  }
}

// Fetch additional webinar data
async function fetchAdditionalWebinarData(
  accessToken: string,
  webinarId: string,
  type: 'past' | 'upcoming',
  rateLimiter: RateLimitManager
): Promise<any> {
  const additionalData: any = {};

  console.log(`[SYNC] Fetching additional data for ${type} webinar ${webinarId}`);

  // Fetch registrant count for all webinars
  additionalData.registrantCount = await fetchRegistrantCount(accessToken, webinarId, rateLimiter);

  // Fetch participant data for past webinars
  if (type === 'past') {
    const participantData = await fetchParticipantData(accessToken, webinarId, rateLimiter);
    additionalData.participantCount = participantData.count;
    additionalData.avgAttendanceDuration = participantData.avgDuration;
  }

  // Fetch tracking sources (only for upcoming webinars)
  if (type === 'upcoming') {
    try {
      additionalData.trackingSources = await rateLimiter.executeWithRateLimit(async () => {
        const response = await fetch(`https://api.zoom.us/v2/webinars/${webinarId}/tracking_sources`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          return data.tracking_sources || [];
        }
        return [];
      });
    } catch (error) {
      console.error(`[SYNC] Failed to fetch tracking sources for ${webinarId}:`, error);
    }
  }

  // Fetch polls, Q&A for past webinars
  if (type === 'past') {
    try {
      additionalData.polls = await rateLimiter.executeWithRateLimit(async () => {
        const response = await fetch(`https://api.zoom.us/v2/past_webinars/${webinarId}/polls`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          return data.questions || [];
        }
        return [];
      });
    } catch (error) {
      console.error(`[SYNC] Failed to fetch polls for ${webinarId}:`, error);
    }

    try {
      additionalData.qa = await rateLimiter.executeWithRateLimit(async () => {
        const response = await fetch(`https://api.zoom.us/v2/past_webinars/${webinarId}/qa`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          return data.questions || [];
        }
        return [];
      });
    } catch (error) {
      console.error(`[SYNC] Failed to fetch Q&A for ${webinarId}:`, error);
    }
  }

  console.log(`[SYNC] Completed fetching additional data for webinar ${webinarId}`);
  return additionalData;
}

// Process a single webinar
async function processWebinar(
  supabase: any,
  accessToken: string,
  queueItem: any,
  rateLimiter: RateLimitManager,
  syncId: string,
  connectionId: string
): Promise<void> {
  try {
    console.log(`[SYNC] Starting to process webinar ${queueItem.webinar_id} (${queueItem.webinar_type})`);
    
    // Mark as processing
    await supabase
      .from('webinar_sync_queue')
      .update({ 
        processing_status: 'processing',
        started_at: new Date().toISOString()
      })
      .eq('id', queueItem.id);

    // Fetch complete webinar details
    const webinarDetails = await rateLimiter.executeWithRateLimit(() => 
      fetchWebinarDetails(accessToken, queueItem.webinar_id, queueItem.webinar_type)
    );

    console.log(`[SYNC] Processing webinar ${webinarDetails.id}: ${webinarDetails.topic}`);
    console.log(`[SYNC] Webinar type: ${queueItem.webinar_type}, Status from API: ${webinarDetails.status}`);

    // Fetch additional data
    const additionalData = await fetchAdditionalWebinarData(
      accessToken,
      queueItem.webinar_id,
      queueItem.webinar_type,
      rateLimiter
    );

    // Determine the correct status
    const status = determineWebinarStatus(webinarDetails, queueItem.webinar_type);

    // Prepare data for upsert - Enhanced with additional data
    const webinarData = {
      webinar_id: webinarDetails.id || webinarDetails.uuid,
      webinar_uuid: webinarDetails.uuid || webinarDetails.id || `webinar-${webinarDetails.id}`,
      connection_id: connectionId,
      topic: webinarDetails.topic,
      type: webinarDetails.type || 5,
      start_time: webinarDetails.start_time,
      duration: webinarDetails.duration || 0,
      timezone: webinarDetails.timezone,
      webinar_created_at: webinarDetails.created_at ? new Date(webinarDetails.created_at).toISOString() : null,
      start_url: webinarDetails.start_url,
      join_url: webinarDetails.join_url,
      status: status, // Use our determined status
      
      // Host information
      host_id: webinarDetails.host_id || 'unknown',
      host_email: webinarDetails.host_email || webinarDetails.host?.email || null,
      alternative_hosts: webinarDetails.alternative_hosts_email ? webinarDetails.alternative_hosts_email.split(',').map((h: string) => h.trim()) : null,
      
      // Registration settings
      registration_url: webinarDetails.registration_url,
      registration_required: webinarDetails.settings?.registrants_require_approval !== undefined || webinarDetails.registration_required || false,
      approval_type: webinarDetails.settings?.approval_type || webinarDetails.approval_type,
      registration_type: webinarDetails.settings?.registration_type || webinarDetails.registration_type,
      max_registrants: webinarDetails.settings?.registrants_restrict_number || webinarDetails.max_registrants || null,
      max_attendees: webinarDetails.settings?.max_attendees || webinarDetails.max_attendees || null,
      
      // Use fetched data for counts
      total_registrants: additionalData.registrantCount || webinarDetails.registrants_count || 0,
      total_attendees: additionalData.participantCount || webinarDetails.participants_count || 0,
      total_minutes: webinarDetails.total_minutes || 0,
      avg_attendance_duration: additionalData.avgAttendanceDuration || webinarDetails.avg_attendance_duration || 0,
      
      // Meeting settings - with null checks
      audio: webinarDetails.settings?.audio || webinarDetails.audio || 'both',
      auto_recording: webinarDetails.settings?.auto_recording || webinarDetails.auto_recording || 'none',
      enforce_login: webinarDetails.settings?.enforce_login || false,
      hd_video: webinarDetails.settings?.hd_video || false,
      hd_video_for_attendees: webinarDetails.settings?.hd_video_for_attendees || false,
      send_1080p_video_to_attendees: webinarDetails.settings?.send_1080p_video_to_attendees || false,
      host_video: webinarDetails.settings?.host_video || false,
      on_demand: webinarDetails.settings?.on_demand || false,
      panelists_video: webinarDetails.settings?.panelists_video || false,
      practice_session: webinarDetails.settings?.practice_session || false,
      question_answer: webinarDetails.settings?.question_answer || webinarDetails.settings?.q_and_a || false,
      registrants_confirmation_email: webinarDetails.settings?.registrants_confirmation_email || false,
      registrants_email_notification: webinarDetails.settings?.registrants_email_notification || false,
      registrants_restrict_number: webinarDetails.settings?.registrants_restrict_number || 0,
      notify_registrants: webinarDetails.settings?.notify_registrants || false,
      post_webinar_survey: webinarDetails.settings?.post_webinar_survey || false,
      survey_url: webinarDetails.settings?.survey_url || webinarDetails.survey_url || null,
      
      // Authentication
      authentication_option: webinarDetails.settings?.authentication_option || null,
      authentication_domains: webinarDetails.settings?.authentication_domains || null,
      authentication_name: webinarDetails.settings?.authentication_name || null,
      
      // Email settings
      email_language: webinarDetails.settings?.email_language || webinarDetails.settings?.language || 'en-US',
      panelists_invitation_email_notification: webinarDetails.settings?.panelists_invitation_email_notification || false,
      
      // Contact information
      contact_name: webinarDetails.settings?.contact_name || webinarDetails.contact_name || null,
      contact_email: webinarDetails.settings?.contact_email || webinarDetails.contact_email || null,
      
      // Q&A settings
      attendees_and_panelists_reminder_email_notification: webinarDetails.settings?.attendees_and_panelists_reminder_email_notification || null,
      follow_up_attendees_email_notification: webinarDetails.settings?.follow_up_attendees_email_notification || null,
      follow_up_absentees_email_notification: webinarDetails.settings?.follow_up_absentees_email_notification || null,
      
      // Password settings
      password: webinarDetails.password || null,
      h323_password: webinarDetails.h323_password || null,
      pstn_password: webinarDetails.pstn_password || null,
      webinar_passcode: webinarDetails.passcode || null,
      encrypted_password: webinarDetails.encrypted_password || null,
      
      // Agenda
      agenda: webinarDetails.agenda || null,
      
      // Tracking fields
      tracking_fields: webinarDetails.tracking_fields || additionalData.trackingSources || null,
      
      // Recurrence
      recurrence: webinarDetails.recurrence || null,
      occurrences: webinarDetails.occurrences || null,
      occurrence_id: webinarDetails.occurrence_id || null,
      
      // Simulive settings
      simulive: webinarDetails.is_simulive || false,
      record_file_id: webinarDetails.record_file_id || null,
      
      // Settings object
      settings: webinarDetails.settings || {},
      
      // Additional data
      additional_data: {
        ...additionalData,
        settings: webinarDetails.settings,
        occurrences: webinarDetails.occurrences || [],
        raw_response: webinarDetails
      },
      
      // Sync metadata
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      sync_status: 'synced',
      
      // Participant sync status
      participant_sync_status: queueItem.webinar_type === 'past' ? 'pending' : 'not_applicable'
    };

    // Log populated vs missing fields
    const populatedFields = Object.keys(webinarData).filter(key => webinarData[key] !== null && webinarData[key] !== undefined);
    const nullFields = Object.keys(webinarData).filter(key => webinarData[key] === null || webinarData[key] === undefined);
    
    console.log(`[SYNC] Populated ${populatedFields.length} fields for webinar ${queueItem.webinar_id}`);
    if (nullFields.length > 0) {
      console.log(`[SYNC] Fields with null/undefined values: ${nullFields.join(', ')}`);
    }

    // Upsert webinar data
    const { error: upsertError } = await supabase
      .from('zoom_webinars')
      .upsert(webinarData, {
        onConflict: 'webinar_id,connection_id'
      });

    if (upsertError) {
      console.error(`[SYNC] ✗ Failed to sync webinar ${queueItem.webinar_id}: ${upsertError.message}`);
      throw upsertError;
    }

    console.log(`[SYNC] ✓ Successfully synced webinar ${queueItem.webinar_id}`);

    // Mark as completed
    await supabase
      .from('webinar_sync_queue')
      .update({ 
        processing_status: 'completed',
        completed_at: new Date().toISOString()
      })
      .eq('id', queueItem.id);

    // Broadcast progress
    await broadcastProgress(
      supabase,
      syncId,
      'webinar',
      `Processed webinar: ${webinarDetails.topic}`,
      { 
        webinar_id: queueItem.webinar_id,
        status: status,
        registrants: additionalData.registrantCount || 0,
        attendees: additionalData.participantCount || 0
      }
    );

  } catch (error: any) {
    console.error(`[SYNC] ✗ Failed to process webinar ${queueItem.webinar_id}:`, error);
    
    // Update queue item with error
    await supabase
      .from('webinar_sync_queue')
      .update({ 
        processing_status: 'failed',
        error_message: error.message,
        retry_count: queueItem.retry_count + 1
      })
      .eq('id', queueItem.id);

    // Broadcast error
    await broadcastProgress(
      supabase,
      syncId,
      'error',
      `Failed to process webinar ${queueItem.webinar_id}: ${error.message}`,
      { webinar_id: queueItem.webinar_id, error: error.message }
    );

    // Re-throw for higher level handling
    throw error;
  }
}

// Main sync handler
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('[SYNC] ====== Starting Zoom Webinar Sync ======');
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing required environment variables');
    }
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { connectionId, syncMode = 'full', dateRange = { pastDays: 90, futureDays: 180 }, resumeSyncId } = await req.json() as SyncRequest;

    // Validate connection
    if (!connectionId) {
      throw new Error('Connection ID is required');
    }

    console.log(`[SYNC] Sync request received - Connection: ${connectionId}, Mode: ${syncMode}`);
    console.log(`[SYNC] Date range: ${dateRange.pastDays} days past, ${dateRange.futureDays} days future`);

    // Initialize or resume sync
    let syncId = resumeSyncId;
    let syncState: any = null;

    if (resumeSyncId) {
      // Resume existing sync
      const { data: existingState } = await supabase
        .from('sync_state')
        .select('*')
        .eq('sync_id', resumeSyncId)
        .single();
      
      if (existingState) {
        syncState = existingState;
        await broadcastProgress(supabase, syncId!, 'status', 'Resuming sync...', { resumed: true });
      }
    }

    if (!syncId) {
      // Create new sync log
      const { data: newSync, error: syncError } = await supabase
        .from('zoom_sync_logs')
        .insert({
          connection_id: connectionId,
          status: 'running',
          started_at: new Date().toISOString(),
          sync_type: syncMode,
          metadata: { dateRange }
        })
        .select()
        .single();

      if (syncError || !newSync) {
        throw new Error('Failed to create sync log');
      }

      syncId = newSync.id;
      console.log(`[SYNC] Created new sync with ID: ${syncId}`);
      await broadcastProgress(supabase, syncId, 'status', 'Starting new sync...', { syncMode, dateRange });
    }

    // Get access token
    const accessToken = await getZoomAccessToken(supabase, connectionId);
    
    // Initialize rate limiter
    const rateLimiter = new RateLimitManager();

    // Calculate date ranges
    const now = new Date();
    const pastDate = new Date(now);
    pastDate.setDate(pastDate.getDate() - (dateRange.pastDays || 90));
    const futureDate = new Date(now);
    futureDate.setDate(futureDate.getDate() + (dateRange.futureDays || 180));

    console.log(`[SYNC] Date range: ${pastDate.toISOString()} to ${futureDate.toISOString()}`);

    // Phase 1: Fetch webinar lists
    await broadcastProgress(supabase, syncId, 'status', 'Fetching webinar lists...', {}, 0);

    const allWebinars: WebinarQueueItem[] = [];
    
    // Fetch past webinars
    console.log('[SYNC] Fetching past webinars...');
    let nextPageToken: string | undefined;
    let pageCount = 0;
    
    do {
      const { webinars, nextPageToken: token } = await rateLimiter.executeWithRateLimit(() =>
        fetchWebinarList(
          accessToken,
          'past',
          { from: pastDate.toISOString().split('T')[0] },
          100,
          nextPageToken
        )
      );
      
      allWebinars.push(...webinars.map(w => ({
        webinar_id: w.id || w.uuid,
        webinar_type: 'past' as const
      })));
      
      nextPageToken = token;
      pageCount++;
      
      await broadcastProgress(
        supabase,
        syncId,
        'progress',
        `Fetching past webinars... (Page ${pageCount})`,
        { pageCount, webinarCount: allWebinars.length },
        5
      );
    } while (nextPageToken);

    console.log(`[SYNC] Found ${allWebinars.length} past webinars`);

    // Fetch upcoming webinars
    console.log('[SYNC] Fetching upcoming webinars...');
    nextPageToken = undefined;
    pageCount = 0;
    const upcomingStart = allWebinars.length;
    
    do {
      const { webinars, nextPageToken: token } = await rateLimiter.executeWithRateLimit(() =>
        fetchWebinarList(
          accessToken,
          'upcoming',
          { to: futureDate.toISOString().split('T')[0] },
          100,
          nextPageToken
        )
      );
      
      allWebinars.push(...webinars.map(w => ({
        webinar_id: w.id || w.uuid,
        webinar_type: 'upcoming' as const
      })));
      
      nextPageToken = token;
      pageCount++;
      
      await broadcastProgress(
        supabase,
        syncId,
        'progress',
        `Fetching upcoming webinars... (Page ${pageCount})`,
        { pageCount, webinarCount: allWebinars.length - upcomingStart },
        10
      );
    } while (nextPageToken);

    console.log(`[SYNC] Found ${allWebinars.length - upcomingStart} upcoming webinars`);
    console.log(`[SYNC] Total webinars to process: ${allWebinars.length}`);

    // Phase 2: Queue webinars for processing
    await broadcastProgress(
      supabase,
      syncId,
      'status',
      `Queuing ${allWebinars.length} webinars for processing...`,
      { totalWebinars: allWebinars.length },
      15
    );

    // Insert webinars into queue
    if (allWebinars.length > 0) {
      const queueItems = allWebinars.map((w, index) => ({
        sync_id: syncId,
        webinar_id: w.webinar_id,
        webinar_type: w.webinar_type,
        priority: 5,
        scheduled_at: new Date().toISOString()
      }));

      const { error: queueError } = await supabase
        .from('webinar_sync_queue')
        .insert(queueItems);

      if (queueError) {
        throw new Error(`Failed to queue webinars: ${queueError.message}`);
      }
    }

    // Save sync state
    await supabase
      .from('sync_state')
      .upsert({
        sync_id: syncId,
        connection_id: connectionId,
        state_type: 'webinar_details',
        state_data: { totalWebinars: allWebinars.length },
        total_items: allWebinars.length,
        processed_items: 0
      });

    // Phase 3: Process webinars
    console.log('[SYNC] Starting to process queued webinars...');
    
    const { data: queuedItems } = await supabase
      .from('webinar_sync_queue')
      .select('*')
      .eq('sync_id', syncId)
      .eq('processing_status', 'pending')
      .order('priority', { ascending: false })
      .order('scheduled_at', { ascending: true });

    if (queuedItems && queuedItems.length > 0) {
      let processedCount = 0;
      let failedCount = 0;
      
      for (const item of queuedItems) {
        try {
          await processWebinar(supabase, accessToken, item, rateLimiter, syncId, connectionId);
          processedCount++;
          
          // Update progress
          const percentage = 15 + (processedCount / queuedItems.length) * 80; // 15-95%
          await broadcastProgress(
            supabase,
            syncId,
            'progress',
            `Processing webinars... (${processedCount}/${queuedItems.length})`,
            { processedCount, totalCount: queuedItems.length },
            percentage
          );
          
          // Update sync state
          await supabase
            .from('sync_state')
            .update({
              processed_items: processedCount,
              last_processed_item: item.webinar_id,
              updated_at: new Date().toISOString()
            })
            .eq('sync_id', syncId)
            .eq('state_type', 'webinar_details');
            
        } catch (error) {
          console.error(`[SYNC] Failed to process webinar ${item.webinar_id}:`, error);
          failedCount++;
          // Continue with next webinar
        }
      }
      
      console.log(`[SYNC] Processed ${processedCount} webinars successfully, ${failedCount} failed`);
    }

    // Phase 4: Complete sync
    await supabase
      .from('zoom_sync_logs')
      .update({
        status: 'completed',
        ended_at: new Date().toISOString(),
        webinars_synced: allWebinars.length,
        metadata: {
          dateRange,
          syncMode,
          totalWebinars: allWebinars.length
        }
      })
      .eq('id', syncId);

    await broadcastProgress(
      supabase,
      syncId,
      'status',
      `Sync completed successfully! Processed ${allWebinars.length} webinars.`,
      { totalWebinars: allWebinars.length },
      100
    );

    console.log('[SYNC] ====== Sync Completed Successfully ======');

    return new Response(
      JSON.stringify({
        success: true,
        syncId,
        webinarsSynced: allWebinars.length,
        message: 'Sync completed successfully'
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    );

  } catch (error: any) {
    console.error('[SYNC] ====== Sync Failed ======');
    console.error('[SYNC] Error:', error);
    
    return new Response(
      JSON.stringify({
        error: error.message || 'An error occurred during sync'
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});
