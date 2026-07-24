-- AUTO-1 (#72): automation trigger engine — user-defined "if {condition} →
-- {action}" rules. Conditions: chat_keyword, player_count, time_of_day,
-- player_flag. Actions: rcon_command, kick, warn, notify_admin. Event-driven
-- conditions are evaluated by @squad/worker-automation over the Redis event
-- streams; chat_keyword is evaluated inline in @squad/worker-log-ingest. Every
-- firing (and every dry-run test) writes an automation_runs row + audit_log
-- entry. Managed via /api/v1/automation-rules. See
-- packages/db/src/schema/automation-rules.ts.
CREATE TABLE IF NOT EXISTS automation_rules (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  server_id uuid REFERENCES servers(id) ON DELETE CASCADE,
  name text NOT NULL,
  condition_type text NOT NULL,
  condition jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_type text NOT NULL,
  action jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES players(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_rules_condition_type_chk
    CHECK (condition_type IN ('chat_keyword','player_count','time_of_day','player_flag')),
  CONSTRAINT automation_rules_action_type_chk
    CHECK (action_type IN ('rcon_command','kick','warn','notify_admin'))
);
CREATE INDEX IF NOT EXISTS automation_rules_enabled_idx ON automation_rules (enabled);
CREATE INDEX IF NOT EXISTS automation_rules_server_idx ON automation_rules (server_id);

CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  server_id uuid,
  fired_at timestamptz NOT NULL DEFAULT now(),
  matched jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_result jsonb,
  dry_run boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  CONSTRAINT automation_runs_status_chk
    CHECK (status IN ('matched','no_match','executed','failed','skipped'))
);
CREATE INDEX IF NOT EXISTS automation_runs_rule_fired_idx
  ON automation_runs (rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_fired_idx ON automation_runs (fired_at DESC);
