-- Make audit_log's id order equal its hash-chain order, and make the hashed
-- created_at text independent of the writer's TimeZone (#36).
--
-- The bigserial default hands out NEW.id when the INSERT starts, before this
-- BEFORE INSERT trigger takes the chain lock. Two concurrent inserts could
-- therefore take the lock in the opposite order of their ids, and a verifier
-- walking ORDER BY id reported a prev_hash break on an untouched table. The
-- trigger now draws the id itself once it holds the lock (held to commit), so
-- a later link always has a larger id. The column default is dropped so no
-- value is drawn before the lock (NOT NULL is checked after BEFORE triggers);
-- the sequence stays owned by the column.
--
-- created_at::text renders in the session TimeZone. The function now pins
-- TimeZone to UTC for its own execution (SET clause), and the verifiers read
-- created_at::text under UTC too. Rows already written by the default UTC
-- sessions keep verifying unchanged.
--
-- Rollback-safe: same columns and hash format. The previous release never
-- supplies audit_log.id, so its inserts get their id from this trigger.
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
