-- VIPSUB-4 (#170): VIP expiry reminders. Widens alert_rules_type_chk with the
-- scheduled `role_expiring` type, seeds the immutable system rule the
-- role-expirer reminder tick attributes its alert_events to, adds the reminder
-- configuration to economy_settings, and creates the `expiry_notifications`
-- dedup ledger. The unique key includes expires_at, so renewing a grant
-- (new expires_at) mechanically re-arms every window without a delete path.
-- See packages/db/src/schema/expiry-notifications.ts.

ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_type_chk;
--> statement-breakpoint
ALTER TABLE alert_rules
  ADD CONSTRAINT alert_rules_type_chk
  CHECK (type IN ('server_crashed','unusual_activity','admin_login_new_ip','custom','role_expiring'));
--> statement-breakpoint
INSERT INTO alert_rules (id, name, type, config, channels, enabled)
VALUES (
  '00000000-0000-7000-8000-000000000170',
  'Истечение VIP',
  'role_expiring',
  '{}'::jsonb,
  '[]'::jsonb,
  true
)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE economy_settings
  ADD COLUMN IF NOT EXISTS vip_expiry_windows_days jsonb NOT NULL DEFAULT '[7,3,1]'::jsonb,
  ADD COLUMN IF NOT EXISTS vip_expiry_warn_in_game boolean NOT NULL DEFAULT true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS expiry_notifications (
  id             uuid         PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  player_id      uuid         NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role_id        uuid         NOT NULL,
  expires_at     timestamptz  NOT NULL,
  window_days    integer      NOT NULL,
  recipient      text         NOT NULL,
  alert_event_id uuid         REFERENCES alert_events(id) ON DELETE SET NULL,
  queued_at      timestamptz,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT expiry_notifications_recipient_chk CHECK (recipient IN ('admin','player')),
  CONSTRAINT expiry_notifications_window_days_chk CHECK (window_days >= 1 AND window_days <= 90)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS expiry_notifications_assignment_window_recipient_key
  ON expiry_notifications (player_id, role_id, expires_at, window_days, recipient);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS expiry_notifications_pending_player_idx
  ON expiry_notifications (player_id) WHERE recipient = 'player' AND queued_at IS NULL;
