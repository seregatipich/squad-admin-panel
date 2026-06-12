-- Migration: Switch players PK from steam_id64 to id UUID.
-- All child tables switch their FK columns from steam_id64 → player_id UUID.
-- steam_id64 stays on players as a nullable unique column.
-- Also: session TTL default is 24h (handled in app config, not DB).
-- Also: panel_meta gets setup_completed flag for setup wizard.

BEGIN;

-- 1. Add UUID id column to players
ALTER TABLE players ADD COLUMN id uuid DEFAULT gen_random_uuid() NOT NULL;

-- 2. Drop FK constraints that reference players(steam_id64)
--    These were created via inline REFERENCES, so PostgreSQL auto-named them {table}_{column}_fkey.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_steam_id64_fkey;
ALTER TABLE player_name_history DROP CONSTRAINT IF EXISTS player_name_history_steam_id64_fkey;
ALTER TABLE player_ip_history DROP CONSTRAINT IF EXISTS player_ip_history_steam_id64_fkey;
ALTER TABLE player_api_tokens DROP CONSTRAINT IF EXISTS player_api_tokens_steam_id64_fkey;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_steam_id64_fkey;
ALTER TABLE config_versions DROP CONSTRAINT IF EXISTS config_versions_author_steam_id64_fkey;
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_deleted_by_steam_id64_fkey;

-- 3. Switch PK from steam_id64 to id
ALTER TABLE players DROP CONSTRAINT players_pkey;
ALTER TABLE players ADD PRIMARY KEY (id);

-- 4. Make steam_id64 nullable and add partial unique index
ALTER TABLE players ALTER COLUMN steam_id64 DROP NOT NULL;
CREATE UNIQUE INDEX players_steam_id64_unique_idx ON players (steam_id64);

-- 5. Add player_id UUID columns to child tables
ALTER TABLE sessions ADD COLUMN player_id uuid;
ALTER TABLE player_name_history ADD COLUMN player_id uuid;
ALTER TABLE player_ip_history ADD COLUMN player_id uuid;
ALTER TABLE player_api_tokens ADD COLUMN player_id uuid;
ALTER TABLE audit_log ADD COLUMN actor_player_id uuid;
ALTER TABLE config_versions ADD COLUMN author_player_id uuid;
ALTER TABLE servers ADD COLUMN deleted_by_player_id uuid;
ALTER TABLE diagnostic_events ADD COLUMN actor_player_id uuid;

-- 6. Backfill player_id from players via steam_id64 join
UPDATE sessions s SET player_id = p.id FROM players p WHERE p.steam_id64 = s.steam_id64;
UPDATE player_name_history h SET player_id = p.id FROM players p WHERE p.steam_id64 = h.steam_id64;
UPDATE player_ip_history h SET player_id = p.id FROM players p WHERE p.steam_id64 = h.steam_id64;
UPDATE player_api_tokens t SET player_id = p.id FROM players p WHERE p.steam_id64 = t.steam_id64;
UPDATE audit_log a SET actor_player_id = p.id FROM players p WHERE p.steam_id64 = a.actor_steam_id64;
UPDATE config_versions c SET author_player_id = p.id FROM players p WHERE p.steam_id64 = c.author_steam_id64;
UPDATE servers s SET deleted_by_player_id = p.id FROM players p WHERE p.steam_id64 = s.deleted_by_steam_id64;
UPDATE diagnostic_events d SET actor_player_id = p.id FROM players p WHERE p.steam_id64 = d.actor_steam_id64;

-- 7. Add NOT NULL where required (child tables with cascade FK)
ALTER TABLE sessions ALTER COLUMN player_id SET NOT NULL;
ALTER TABLE player_name_history ALTER COLUMN player_id SET NOT NULL;
ALTER TABLE player_ip_history ALTER COLUMN player_id SET NOT NULL;
ALTER TABLE player_api_tokens ALTER COLUMN player_id SET NOT NULL;

-- 8. Add FK constraints on new player_id columns
ALTER TABLE sessions ADD CONSTRAINT sessions_player_id_fk
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
ALTER TABLE player_name_history ADD CONSTRAINT player_name_history_player_id_fk
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
ALTER TABLE player_ip_history ADD CONSTRAINT player_ip_history_player_id_fk
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
ALTER TABLE player_api_tokens ADD CONSTRAINT player_api_tokens_player_id_fk
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_player_id_fk
  FOREIGN KEY (actor_player_id) REFERENCES players(id) ON DELETE SET NULL;
ALTER TABLE config_versions ADD CONSTRAINT config_versions_author_player_id_fk
  FOREIGN KEY (author_player_id) REFERENCES players(id) ON DELETE SET NULL;
ALTER TABLE servers ADD CONSTRAINT servers_deleted_by_player_id_fk
  FOREIGN KEY (deleted_by_player_id) REFERENCES players(id) ON DELETE SET NULL;

-- 9. Drop old steam_id64 FK columns from child tables
--    (indexes on these columns are auto-dropped)
ALTER TABLE sessions DROP COLUMN steam_id64;
ALTER TABLE player_name_history DROP COLUMN steam_id64;
ALTER TABLE player_ip_history DROP COLUMN steam_id64;
ALTER TABLE player_api_tokens DROP COLUMN steam_id64;
ALTER TABLE audit_log DROP COLUMN actor_steam_id64;
ALTER TABLE config_versions DROP COLUMN author_steam_id64;
ALTER TABLE servers DROP COLUMN deleted_by_steam_id64;
ALTER TABLE diagnostic_events DROP COLUMN actor_steam_id64;

-- 10. Add indexes on new player_id columns
CREATE INDEX sessions_player_id_idx ON sessions (player_id);
CREATE INDEX player_api_tokens_player_id_idx ON player_api_tokens (player_id);
CREATE INDEX audit_log_actor_player_idx ON audit_log (actor_player_id, created_at);
CREATE UNIQUE INDEX player_name_history_player_name_key ON player_name_history (player_id, name_normalized);
CREATE UNIQUE INDEX player_ip_history_player_ip_key ON player_ip_history (player_id, ip);

-- 11. Update audit_log check constraint
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_kind;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_kind CHECK (
  (actor_kind = 'steam' AND actor_player_id IS NOT NULL AND actor_system_label IS NULL)
  OR (actor_kind = 'system' AND actor_player_id IS NULL AND actor_system_label IS NOT NULL)
);

-- 12. Update config_versions check constraint
ALTER TABLE config_versions DROP CONSTRAINT IF EXISTS config_versions_author_presence;
ALTER TABLE config_versions ADD CONSTRAINT config_versions_author_presence CHECK (
  author_player_id IS NOT NULL OR author_label IS NOT NULL
);

-- 13. Setup wizard
ALTER TABLE panel_meta ADD COLUMN setup_completed boolean NOT NULL DEFAULT false;
ALTER TABLE panel_meta ADD COLUMN organization_name text NOT NULL DEFAULT '';

COMMIT;
