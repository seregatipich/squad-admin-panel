-- SYNC-1 (#34): durable transactional outbox for Admins.cfg sync tasks.
-- A row is written in the same transaction as the domain mutation, so a
-- committed mutation always leaves a durable sync task; a relay moves pending
-- rows onto the events:admins-cfg-sync:<server_id> stream at-least-once.
CREATE TABLE IF NOT EXISTS admins_cfg_sync_outbox (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  relayed_at timestamptz,
  stream_id text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS admins_cfg_sync_outbox_pending_idx
  ON admins_cfg_sync_outbox (created_at)
  WHERE relayed_at IS NULL;
