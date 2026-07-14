-- SEED-4 (#143): per-player seed notification subscriptions, schedule lead time,
-- and the built-in AUTO-3 policies consumed by the shared notification helper.
CREATE TABLE IF NOT EXISTS seed_subscriptions (
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seed_subscriptions_pk PRIMARY KEY (player_id, server_id, channel),
  CONSTRAINT seed_subscriptions_channel_chk CHECK (channel IN ('email', 'webpush'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS seed_subscriptions_server_channel_idx
  ON seed_subscriptions (server_id, channel);
--> statement-breakpoint

ALTER TABLE seed_schedule
  ADD COLUMN IF NOT EXISTS notify_minutes_before integer NOT NULL DEFAULT 0;
--> statement-breakpoint

DO $$
BEGIN
  ALTER TABLE seed_schedule
    ADD CONSTRAINT seed_schedule_notify_minutes_chk
    CHECK (notify_minutes_before BETWEEN 0 AND 1440);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

INSERT INTO alert_rules (id, name, type, config, channels, enabled)
VALUES
  ('00000000-0000-7000-8000-000000000077', 'Seed call — manual', 'custom', '{"eventKind":"seed.call_sent"}'::jsonb, '["email","webpush"]'::jsonb, true),
  ('00000000-0000-7000-8000-000000000078', 'Seed call — automatic', 'custom', '{"eventKind":"server.seeding_started"}'::jsonb, '["email","webpush"]'::jsonb, true)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

ALTER TABLE discord_message_templates
  DROP CONSTRAINT IF EXISTS discord_message_templates_event_type_chk;
--> statement-breakpoint
ALTER TABLE discord_message_templates
  ADD CONSTRAINT discord_message_templates_event_type_chk CHECK (
    event_type IN (
      'server_crashed','ban_issued','unban','kick','warn','admin_login',
      'player_report','match_ended','map_changed','marked_player_joined',
      'drift_detected','server_monitoring','seed_needed'
    )
  );
--> statement-breakpoint
INSERT INTO discord_message_templates (event_type, locale, template)
VALUES (
  'seed_needed', 'en',
  '{"title":"Seeders needed","url":null,"description":"`{server_name}` needs seeders. Join: {join_link}","color":16426522,"fields":[{"name":"Server","value":"{server_name}","inline":true},{"name":"Layer","value":"{map}","inline":true}]}'::jsonb
)
ON CONFLICT (event_type) DO NOTHING;
