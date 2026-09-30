-- Persists the resumable upload session URL a destination handed back
-- mid-upload (currently only YouTube), so a retry after a transport failure
-- can query the session status instead of opening a new session and
-- re-uploading the file or duplicating an already-finalized upload.
-- Add-only: the previous release never reads or writes this column.
ALTER TABLE media_publications
  ADD COLUMN IF NOT EXISTS upload_session_url text NULL;
