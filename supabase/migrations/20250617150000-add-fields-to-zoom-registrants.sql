-- Add new fields to zoom_registrants table
ALTER TABLE public.zoom_registrants
ADD COLUMN IF NOT EXISTS registrant_uuid TEXT NULL,
ADD COLUMN IF NOT EXISTS registration_time TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS source_id TEXT NULL,
ADD COLUMN IF NOT EXISTS tracking_source TEXT NULL,
ADD COLUMN IF NOT EXISTS language TEXT NULL;

-- Optional: Add comments for new columns (if supported and desired)
COMMENT ON COLUMN public.zoom_registrants.registrant_uuid IS 'Distinct UUID for the registrant, if provided by Zoom.';
COMMENT ON COLUMN public.zoom_registrants.registration_time IS 'The exact time the registrant registered for the webinar, from Zoom.';
COMMENT ON COLUMN public.zoom_registrants.source_id IS 'Source ID, if available from Zoom registration data.';
COMMENT ON COLUMN public.zoom_registrants.tracking_source IS 'Tracking source, if available from Zoom registration data.';
COMMENT ON COLUMN public.zoom_registrants.language IS 'Language preference of the registrant, if available from Zoom.';
