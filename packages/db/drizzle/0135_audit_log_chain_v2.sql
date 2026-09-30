-- Harden the audit_log hash chain (#1251, #1064): final definition of
-- audit_log_append().
--
-- 1. TRUNCATE bypassed the row-level append-only triggers on audit_log and
--    config_versions: `TRUNCATE audit_log` emptied the table and an empty chain
--    verified as intact. Statement-level BEFORE TRUNCATE triggers now raise the
--    same "append-only" error (also when reached through CASCADE).
--
-- 2. The v1 canonical form hashed only action_type|target_type|target_id|
--    context::text|created_at: actor, IP, before/after snapshots, status code
--    and duration could be rewritten without breaking the chain, and '|' inside
--    a field made the encoding ambiguous. New rows are hashed with the v2 form:
--
--      'v2' || field(id) || field(created_at UTC, microseconds) ||
--      field(actor_kind) || field(actor_player_id) || field(actor_token_id) ||
--      field(actor_system_label) || field(actor_ip) || field(action_type) ||
--      field(target_type) || field(target_id) || field(before_snapshot) ||
--      field(after_snapshot) || field(context) || field(status_code) ||
--      field(duration_ms)
--
--    where field(NULL) = '|-' and field(v) = '|' || octet_length(v) || ':' || v
--    over each column's ::text rendering. The verifier
--    (apps/api/src/lib/audit-chain.ts) mirrors it. Existing rows keep
--    hash_version = 1 and are still verified with the v1 form; a v1 row after
--    the first v2 row is reported as a break (no downgrade).
--
-- This definition supersedes every earlier audit_log_append():
-- 0119_audit_log_id_in_chain_order, 0119_schema_integrity_hardening and
-- 0122_audit_log_chain_order. It keeps what they established: the chain lock is
-- taken first, the id is drawn inside the trigger after the lock (ascending id
-- is the chain order), and the function pins TimeZone to UTC. It must sort
-- after all of them.
--
-- Rollback-safe: hash_version is an added column with a constant default and
-- the previous release never names it. The previous release's verifier reports
-- v2 rows as a row_hash break, but writes keep working because the trigger, not
-- the application, computes the hash.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS hash_version smallint NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_hash_field_v2(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN '|-'
    ELSE '|' || octet_length(value)::text || ':' || value
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_append()
RETURNS trigger
LANGUAGE plpgsql
SET "TimeZone" = 'UTC'
AS $$
DECLARE
  prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_log', 0));
  NEW.id := nextval(pg_get_serial_sequence('audit_log', 'id'));
  SELECT row_hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.hash_version := 2;
  NEW.row_hash := digest(
    COALESCE(prev, ''::bytea) ||
    convert_to(
      'v2'
        || audit_log_hash_field_v2(NEW.id::text)
        || audit_log_hash_field_v2(
             to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
        || audit_log_hash_field_v2(NEW.actor_kind)
        || audit_log_hash_field_v2(NEW.actor_player_id::text)
        || audit_log_hash_field_v2(NEW.actor_token_id::text)
        || audit_log_hash_field_v2(NEW.actor_system_label)
        || audit_log_hash_field_v2(NEW.actor_ip::text)
        || audit_log_hash_field_v2(NEW.action_type)
        || audit_log_hash_field_v2(NEW.target_type)
        || audit_log_hash_field_v2(NEW.target_id)
        || audit_log_hash_field_v2(NEW.before_snapshot::text)
        || audit_log_hash_field_v2(NEW.after_snapshot::text)
        || audit_log_hash_field_v2(NEW.context::text)
        || audit_log_hash_field_v2(NEW.status_code::text)
        || audit_log_hash_field_v2(NEW.duration_ms::text),
      'UTF8'
    ),
    'sha256'
  );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON audit_log;
--> statement-breakpoint
CREATE TRIGGER trg_audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_config_versions_no_truncate ON config_versions;
--> statement-breakpoint
CREATE TRIGGER trg_config_versions_no_truncate
BEFORE TRUNCATE ON config_versions
FOR EACH STATEMENT EXECUTE FUNCTION config_versions_deny();
