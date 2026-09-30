-- Issue #77: schema integrity and storage hardening. Every step is additive or
-- only tightens what the previous release already relies on, so a rollback to
-- it runs against this schema (see "Rollback" notes per step).
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

-- 2. audit_log hash chain (#1066, #1067).
-- a) The canonical timestamp text is pinned to UTC/ISO. `created_at::text`
--    follows the session's TimeZone and DateStyle, so a writer or verifier with
--    another setting produced a different hash. The SET clauses make the
--    rendering independent of the caller; UTC/ISO is what every existing row
--    was hashed with (the server default is UTC), so the chain is unchanged.
-- b) The row id is drawn after the advisory lock is held. The bigserial
--    default was evaluated before the trigger, so a session could hold a lower
--    id yet link to a row with a higher one, breaking the id-ordered chain.
--    The column default is dropped so each row consumes one sequence value;
--    the trigger assigns every id (an explicit id is overridden too) and the
--    NOT NULL check runs after it.
-- Rollback: the previous release's verifiers render `created_at::text` in a
-- UTC session, which equals the pinned text, and its inserts never set `id`.
CREATE OR REPLACE FUNCTION audit_log_created_at_text(ts timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, MDY'
AS $$ SELECT ts::text $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_append() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_log', 0));
  NEW.id := nextval(pg_get_serial_sequence('audit_log', 'id'));
  SELECT row_hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.row_hash := digest(
    COALESCE(prev, ''::bytea) ||
    convert_to(
      NEW.action_type
        || '|' || COALESCE(NEW.target_type, '')
        || '|' || COALESCE(NEW.target_id, '')
        || '|' || NEW.context::text
        || '|' || audit_log_created_at_text(NEW.created_at),
      'UTF8'
    ),
    'sha256'
  );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER TABLE audit_log ALTER COLUMN id DROP DEFAULT;
--> statement-breakpoint

-- 3. config_versions.parent_version_id references a real version again
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

-- 4. Redundant indexes (#1077, #1082): each duplicates the leading column(s)
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

-- 5. Scheduler reads (#1083): the tick now selects only entries it can still
-- execute; these partial indexes match those predicates exactly.
CREATE INDEX IF NOT EXISTS rotation_schedule_pending_idx
  ON rotation_schedule (scheduled_at) WHERE enabled AND last_executed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS seed_schedule_active_idx
  ON seed_schedule (starts_at) WHERE enabled AND (recurrence IS NOT NULL OR last_executed_at IS NULL);
--> statement-breakpoint

-- 6. Ban-appeal tracking tokens are stored as sha256 hex only (#1084), like
-- media_upload_tokens.token_hash. Existing tokens are hashed and their
-- plaintext cleared. The trigger hashes a plaintext token written by the
-- previous release, so no plaintext is stored even after a rollback; that
-- release's status page cannot look a token up by plaintext, so after a
-- rollback applicants see "not found" until the next roll forward.
ALTER TABLE ban_appeals ADD COLUMN IF NOT EXISTS tracking_token_hash text;
--> statement-breakpoint
ALTER TABLE ban_appeals ALTER COLUMN tracking_token DROP NOT NULL;
--> statement-breakpoint
UPDATE ban_appeals
   SET tracking_token_hash = encode(sha256(convert_to(tracking_token, 'UTF8')), 'hex'),
       tracking_token = NULL
 WHERE tracking_token IS NOT NULL;
--> statement-breakpoint
ALTER TABLE ban_appeals ALTER COLUMN tracking_token_hash SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS ban_appeals_tracking_token_key;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ban_appeals_tracking_token_hash_key
  ON ban_appeals (tracking_token_hash);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ban_appeals_hash_tracking_token() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tracking_token IS NOT NULL THEN
    NEW.tracking_token_hash := encode(sha256(convert_to(NEW.tracking_token, 'UTF8')), 'hex');
    NEW.tracking_token := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ban_appeals_hash_tracking_token ON ban_appeals;
--> statement-breakpoint
CREATE TRIGGER trg_ban_appeals_hash_tracking_token
  BEFORE INSERT OR UPDATE OF tracking_token ON ban_appeals
  FOR EACH ROW EXECUTE FUNCTION ban_appeals_hash_tracking_token();
--> statement-breakpoint

-- 7. events_appended NOTIFY once per statement (#1089). The 0116 row trigger
-- called pg_notify for every inserted row on the combat hot path; the
-- statement trigger announces each distinct (server_id, kind) of the batch
-- once. Channel and payload are unchanged, so every listener keeps working.
CREATE OR REPLACE FUNCTION events_notify_appended() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  appended record;
BEGIN
  FOR appended IN SELECT DISTINCT server_id, kind FROM new_events LOOP
    PERFORM pg_notify(
      'events_appended',
      json_build_object('server_id', appended.server_id, 'kind', appended.kind)::text
    );
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_events_notify_appended ON events;
--> statement-breakpoint
CREATE TRIGGER trg_events_notify_appended
  AFTER INSERT ON events
  REFERENCING NEW TABLE AS new_events
  FOR EACH STATEMENT EXECUTE FUNCTION events_notify_appended();
