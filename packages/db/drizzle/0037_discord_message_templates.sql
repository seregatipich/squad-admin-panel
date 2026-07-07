-- DISCORD-3 (#150): editable Discord embed templates, one row per event type.
-- The default template for every event type is seeded here exactly once;
-- re-running the migration is a no-op via ON CONFLICT DO NOTHING. The seed JSON
-- is kept in sync with DEFAULT_DISCORD_TEMPLATES (packages/shared-config) by an
-- integration test.
CREATE TABLE IF NOT EXISTS discord_message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL UNIQUE,
  locale text NOT NULL DEFAULT 'en',
  template jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discord_message_templates_event_type_chk CHECK (
    event_type IN (
      'server_crashed','ban_issued','unban','kick','warn','admin_login',
      'player_report','match_ended','map_changed','marked_player_joined',
      'drift_detected','server_monitoring'
    )
  ),
  CONSTRAINT discord_message_templates_locale_chk CHECK (locale IN ('en','ru'))
);
--> statement-breakpoint
INSERT INTO discord_message_templates (event_type, locale, template) VALUES
  ('server_crashed', 'en', '{"title":"Server crashed","url":null,"description":"`{server_name}` has crashed and is restarting.","color":15548997,"fields":[{"name":"Server","value":"{server_name}","inline":true}]}'::jsonb),
  ('ban_issued', 'en', '{"title":"Player banned","url":"{player_url}","description":"{player_name} was banned on `{server_name}`.","color":15548997,"fields":[{"name":"Player","value":"{player_name}","inline":true},{"name":"Steam ID","value":"{steam_id64}","inline":true},{"name":"Reason","value":"{reason}","inline":false},{"name":"Duration","value":"{duration}","inline":true},{"name":"Admin","value":"{actor_name}","inline":true}]}'::jsonb),
  ('unban', 'en', '{"title":"Player unbanned","url":"{player_url}","description":"{player_name} was unbanned on `{server_name}`.","color":5763719,"fields":[{"name":"Player","value":"{player_name}","inline":true},{"name":"Steam ID","value":"{steam_id64}","inline":true},{"name":"Admin","value":"{actor_name}","inline":true}]}'::jsonb),
  ('kick', 'en', '{"title":"Player kicked","url":"{player_url}","description":"{player_name} was kicked from `{server_name}`.","color":16426522,"fields":[{"name":"Player","value":"{player_name}","inline":true},{"name":"Steam ID","value":"{steam_id64}","inline":true},{"name":"Reason","value":"{reason}","inline":false},{"name":"Admin","value":"{actor_name}","inline":true}]}'::jsonb),
  ('warn', 'en', '{"title":"Player warned","url":"{player_url}","description":"{player_name} was warned on `{server_name}`.","color":16426522,"fields":[{"name":"Player","value":"{player_name}","inline":true},{"name":"Steam ID","value":"{steam_id64}","inline":true},{"name":"Reason","value":"{reason}","inline":false},{"name":"Admin","value":"{actor_name}","inline":true}]}'::jsonb),
  ('admin_login', 'en', '{"title":"Admin logged in","url":"{player_url}","description":"{actor_name} joined `{server_name}` as admin.","color":5793266,"fields":[{"name":"Admin","value":"{actor_name}","inline":true}]}'::jsonb),
  ('player_report', 'en', '{"title":"Player reported","url":"{player_url}","description":"{player_name} was reported on `{server_name}`.","color":16426522,"fields":[{"name":"Player","value":"{player_name}","inline":true},{"name":"Steam ID","value":"{steam_id64}","inline":true},{"name":"Reason","value":"{reason}","inline":false},{"name":"Reporter","value":"{actor_name}","inline":true}]}'::jsonb),
  ('match_ended', 'en', '{"title":"Match ended","url":null,"description":"A match ended on `{server_name}`.","color":5793266,"fields":[{"name":"Map","value":"{map}","inline":true}]}'::jsonb),
  ('map_changed', 'en', '{"title":"Map changed","url":null,"description":"`{server_name}` switched to {map}.","color":5793266,"fields":[{"name":"Map","value":"{map}","inline":true}]}'::jsonb),
  ('marked_player_joined', 'en', '{"title":"Marked player joined","url":"{player_url}","description":"{player_name} joined `{server_name}`.","color":16426522,"fields":[{"name":"Player","value":"{player_name}","inline":true},{"name":"Steam ID","value":"{steam_id64}","inline":true},{"name":"Note","value":"{reason}","inline":false}]}'::jsonb),
  ('drift_detected', 'en', '{"title":"Config drift detected","url":null,"description":"Configuration drift was detected on `{server_name}`.","color":16426522,"fields":[{"name":"Server","value":"{server_name}","inline":true}]}'::jsonb),
  ('server_monitoring', 'en', '{"title":"Server monitoring","url":null,"description":"Monitoring update for `{server_name}`.","color":10070709,"fields":[{"name":"Server","value":"{server_name}","inline":true}]}'::jsonb)
ON CONFLICT (event_type) DO NOTHING;
