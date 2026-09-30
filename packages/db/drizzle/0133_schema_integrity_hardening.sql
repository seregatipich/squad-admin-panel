-- Issue #77: schema integrity hardening. Every step is additive or only
-- tightens what the previous release already relies on, so a rollback to it
-- runs against this schema (see "Rollback" notes per step). The audit_log hash
-- chain is in 0135_audit_log_chain_v2, the ban-appeal token in
-- 0134_appeal_token_hash_and_api_token_index, the NOTIFY trigger in
-- 0132_events_notify_per_statement.
--
-- (Migrations 0042 and 0090 cite `ai_docs/adr/2026-07-09-map-rotation-managed-vs-native.md`;
-- that ADR now lives in docs/architecture/decisions.md. Applied migrations are
-- never edited, so their comments keep the old path.)

-- 1. Actor/author references on the append-only tables (#1069, #1076).
-- `ON DELETE SET NULL` was unreachable: the FK action runs as an UPDATE, which
-- the no-update triggers and the actor CHECK constraints reject, so deleting a
-- referenced player or token failed with "audit_log is append-only". Declare
-- what actually happens — NO ACTION — so the failure is an explicit foreign-key
-- violation. Players with history are anonymised, never deleted.
-- Rollback: the previous release never deletes such rows.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_player_id_fk;
--> statement-breakpoint
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_player_id_fk
  FOREIGN KEY (actor_player_id) REFERENCES players(id) NOT VALID;
--> statement-breakpoint
ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_actor_player_id_fk;
--> statement-breakpoint
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_token_id_fkey;
--> statement-breakpoint
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_token_id_fkey
  FOREIGN KEY (actor_token_id) REFERENCES player_api_tokens(id) NOT VALID;
--> statement-breakpoint
ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_actor_token_id_fkey;
--> statement-breakpoint
ALTER TABLE config_versions DROP CONSTRAINT IF EXISTS config_versions_author_player_id_fk;
--> statement-breakpoint
ALTER TABLE config_versions ADD CONSTRAINT config_versions_author_player_id_fk
  FOREIGN KEY (author_player_id) REFERENCES players(id) NOT VALID;
--> statement-breakpoint
ALTER TABLE config_versions VALIDATE CONSTRAINT config_versions_author_player_id_fk;
--> statement-breakpoint

-- 2. config_versions.parent_version_id references a real version again
-- (#1070); 0008 recreated the table without the FK 0003 had. NOT VALID keeps
-- the lock short and admits legacy orphans; it is validated when none exist.
-- NO ACTION (checked at statement end) still lets a server delete cascade
-- through the server's whole chain.
ALTER TABLE config_versions DROP CONSTRAINT IF EXISTS config_versions_parent_version_id_fk;
--> statement-breakpoint
ALTER TABLE config_versions ADD CONSTRAINT config_versions_parent_version_id_fk
  FOREIGN KEY (parent_version_id) REFERENCES config_versions(id) NOT VALID;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM config_versions c
    WHERE c.parent_version_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM config_versions p WHERE p.id = c.parent_version_id)
  ) THEN
    ALTER TABLE config_versions VALIDATE CONSTRAINT config_versions_parent_version_id_fk;
  END IF;
END$$;
--> statement-breakpoint

-- 3. Redundant indexes (#1077, #1082): each duplicates the leading column(s)
-- of a unique index or primary key (a btree serves DESC order by scanning
-- backwards), or indexes a lone boolean the planner never picks. Rollback: no
-- query depends on them for correctness.
DROP INDEX IF EXISTS matches_server_started_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS game_votes_server_started_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS role_squad_permissions_role_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS player_kit_time_player_id_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS media_links_media_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS issue_links_issue_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS automation_rules_enabled_idx;
--> statement-breakpoint

-- 4. Scheduler reads (#1083): the tick now selects only entries it can still
-- execute; these partial indexes match those predicates exactly.
CREATE INDEX IF NOT EXISTS rotation_schedule_pending_idx
  ON rotation_schedule (scheduled_at) WHERE enabled AND last_executed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS seed_schedule_active_idx
  ON seed_schedule (starts_at) WHERE enabled AND (recurrence IS NOT NULL OR last_executed_at IS NULL);
