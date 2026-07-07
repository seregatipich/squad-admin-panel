-- VIP integration (#5): durable idempotency for lifecycle events from vip-user-service
CREATE TABLE IF NOT EXISTS vip_lifecycle_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
  tier text,
  purchase_id text,
  action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CONSTRAINT vip_lifecycle_events_event_type_chk
    CHECK (event_type IN ('vip.purchased','vip.extended','vip.expired','vip.refunded')),
  CONSTRAINT vip_lifecycle_events_action_chk
    CHECK (action IN ('assigned','revoked','ignored'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vip_lifecycle_events_player_idx
  ON vip_lifecycle_events (player_id, received_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vip_lifecycle_events_purchase_idx
  ON vip_lifecycle_events (purchase_id)
  WHERE purchase_id IS NOT NULL;
