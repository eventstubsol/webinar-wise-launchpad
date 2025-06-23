
/**
 * Database types for Zoom webinar data and related entities
 */

import { WebinarStatus, WebinarType, ApprovalType } from './enums';
import { WebinarSettings, RegistrantInfo, RecordingInfo, PanelistInfo, ChatMessageInfo, TrackingInfo } from './jsonTypes';

/** Core webinar entity from Zoom API */
export interface ZoomWebinar {
  id: string;
  connection_id: string;
  webinar_id: string;
  webinar_uuid: string | null;
  host_id: string | null;
  host_email: string | null;
  topic: string;
  agenda: string | null;
  type: WebinarType | null;
  status: WebinarStatus | null;
  start_time: string | null;
  duration: number | null;
  timezone: string | null;
  registration_required: boolean | null;
  registration_url: string | null;
  join_url: string | null;
  password: string | null;
  approval_type: ApprovalType | null;
  max_registrants: number | null;
  attendees_count: number | null;
  registrants_count: number | null;
  settings: WebinarSettings | null;
  recurrence: any | null; // JSON type
  occurrences: any | null; // JSON type
  tracking_fields: TrackingInfo | null;
  panelists: PanelistInfo[] | null;
  synced_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  // New participant sync tracking fields
  participant_sync_status: 'not_applicable' | 'pending' | 'synced' | 'failed' | 'no_participants' | null;
  participant_sync_attempted_at: string | null;
  participant_sync_error: string | null;
}

/** Webinar registrant information */
export interface ZoomRegistrant {
  id: string; // DB primary key
  webinar_id: string; // Foreign key to zoom_webinars table
  registrant_id: string; // Zoom's unique ID for the registrant (e.g., from apiRegistrant.id)
  registrant_uuid: string | null; // A separate UUID for the registrant, if provided by Zoom
  registrant_email: string;
  first_name: string | null;
  last_name: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  zip: string | null;
  state: string | null;
  phone: string | null;
  industry: string | null;
  org: string | null;
  job_title: string | null;
  purchasing_time_frame: string | null;
  role_in_purchase_process: string | null;
  no_of_employees: string | null;
  comments: string | null;
  status: string | null; // e.g., 'approved', 'pending', 'denied'
  create_time: string | null; // Timestamp from Zoom, possibly when the record was created on their end (apiRegistrant.create_time)
  registration_time: string | null; // Timestamp from Zoom, actual time of registration (apiRegistrant.registration_time)
  join_url: string | null;
  custom_questions: RegistrantInfo | null; // JSONB, for custom registration questions
  source_id: string | null; // Tracking source ID, if provided
  tracking_source: string | null; // Tracking source name, if provided
  language: string | null; // Registrant's language preference

  // Fields primarily from participant data, but included for completeness if API ever sends them with registrants
  join_time: string | null; // Actual time participant joined
  leave_time: string | null; // Actual time participant left
  duration: number | null; // Duration of attendance in minutes
  attended: boolean | null; // Whether the registrant attended

  // Database audit fields
  created_at: string | null; // Timestamp of when the record was created in our database
  updated_at: string | null; // Timestamp of when the record was last updated in our database
}

/** Webinar recording information */
export interface ZoomRecording {
  id: string;
  webinar_id: string;
  recording_id: string;
  recording_uuid: string | null;
  account_id: string | null;
  host_id: string | null;
  topic: string | null;
  type: string | null;
  start_time: string | null;
  duration: number | null;
  share_url: string | null;
  total_size: number | null;
  recording_count: number | null;
  recording_files: RecordingInfo[] | null;
  password: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Webinar panelist information */
export interface ZoomPanelist {
  id: string;
  webinar_id: string;
  panelist_id: string;
  name: string | null;
  email: string | null;
  join_url: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Webinar chat message */
export interface ZoomChatMessage {
  id: string;
  webinar_id: string;
  message_id: string;
  sender: string | null;
  message: string | null;
  timestamp: string | null;
  message_type: string | null;
  created_at: string | null;
}

/** Webinar tracking information */
export interface ZoomWebinarTracking {
  id: string;
  webinar_id: string;
  tracking_field: string;
  tracking_value: string | null;
  created_at: string | null;
}
