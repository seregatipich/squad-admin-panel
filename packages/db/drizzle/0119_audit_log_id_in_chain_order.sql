-- Allocate audit_log ids in hash-chain order (#49).
--
-- The bigserial default evaluated nextval() before the BEFORE INSERT trigger
-- took the chain's advisory lock. Two concurrent writers could therefore get
-- ids in one order and the lock in the other, chaining row N after row N+1.
-- The verifier (scripts/verify-audit-chain.ts, /api/v1/audit/verify-chain)
-- walks ORDER BY id and reported a false "Chain break" for that benign race.
--
-- The id is now drawn inside the trigger, after the lock, so ascending id is
-- the chain order. The column default is dropped so no id is burnt before the
-- trigger; an explicitly supplied id (a data-only restore) is kept as given.
--
-- Rollback-safe: the previous release never supplies an id, and this trigger
-- (which a rollback does not undo) fills it in; the hash payload is unchanged.
CREATE OR REPLACE FUNCTION audit_log_append()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prev bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_log', 0));
  IF NEW.id IS NULL THEN
    NEW.id := nextval('audit_log_id_seq'::regclass);
  END IF;
  SELECT row_hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.row_hash := digest(
    COALESCE(prev, ''::bytea) ||
    convert_to(
      NEW.action_type
        || '|' || COALESCE(NEW.target_type, '')
        || '|' || COALESCE(NEW.target_id, '')
        || '|' || NEW.context::text
        || '|' || NEW.created_at::text,
      'UTF8'
    ),
    'sha256'
  );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER TABLE audit_log ALTER COLUMN id DROP DEFAULT;
