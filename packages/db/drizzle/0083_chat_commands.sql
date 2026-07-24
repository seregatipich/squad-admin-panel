-- AUTO-4 (#75): in-game chat commands (`!stats`, `!rules`, `!report`) recognized
-- from live chat by @squad/worker-log-ingest
-- (apps/workers/log-ingest/src/chat/commands.ts) and answered over RCON, with an
-- append-only invocation history. `!report` still delegates the report record
-- itself to REPORT-1 (player_reports); this table only logs the AUTO-4 history.
-- See packages/db/src/schema/chat-commands.ts.
CREATE TABLE IF NOT EXISTS chat_command_invocations (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  command text NOT NULL,
  args text NOT NULL DEFAULT '',
  responded boolean NOT NULL DEFAULT false,
  response_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_command_invocations_command_check
    CHECK (command IN ('stats','rules','report'))
);
CREATE INDEX IF NOT EXISTS chat_command_invocations_server_created_idx
  ON chat_command_invocations (server_id, created_at);

-- Per-server AUTO-4 toggle + configurable `!rules` text on server_settings.
ALTER TABLE server_settings
  ADD COLUMN IF NOT EXISTS chat_commands_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE server_settings
  ADD COLUMN IF NOT EXISTS rules_text text;
