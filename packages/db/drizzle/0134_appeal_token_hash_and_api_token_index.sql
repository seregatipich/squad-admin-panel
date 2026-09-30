-- #78: two schema-level fixes from the packages/db security audit.
--
-- 1. player_api_tokens had no index on token_hash even though every
--    Bearer-token auth request looks tokens up by it
--    (apps/api/src/plugins/auth.ts), forcing a full table scan per request,
--    including for well-formed-but-invalid tokens. Hashes are also expected
--    to be unique per minted token, matching media_upload_tokens.token_hash.
-- 2. ban_appeals.tracking_token stored the applicant's portal secret as
--    plaintext; a database read or leak could be used directly to pull up
--    (and, through the panel side, act on) anyone's appeal. It is supplemented
--    with the sha-256 hash of the same value, mirroring
--    media_upload_tokens.token_hash / player_api_tokens.token_hash. Existing
--    rows are backfilled in place with the same base64url sha-256 the API
--    now computes (packages/db/src/schema/ban-appeals.ts).
--
-- Rollback-safe (expand step only): tracking_token stays in place, relaxed to
-- nullable, and its unique index is kept, so the previous release can still
-- INSERT appeals with a plaintext token and look them up by it. tracking_token_hash
-- is nullable for the same reason (the previous release does not write it);
-- a BEFORE INSERT trigger derives it from a plaintext token when the writer
-- did not supply one, so rows created during a rollback stay reachable after
-- the roll-forward. The new release writes only the hash. Dropping
-- tracking_token, its index and the trigger belongs to a later release.

CREATE UNIQUE INDEX IF NOT EXISTS player_api_tokens_token_hash_key ON player_api_tokens (token_hash);
--> statement-breakpoint
ALTER TABLE ban_appeals ADD COLUMN IF NOT EXISTS tracking_token_hash text;
--> statement-breakpoint
UPDATE ban_appeals
  SET tracking_token_hash = translate(
    encode(digest(tracking_token, 'sha256'), 'base64'),
    '+/=',
    '-_'
  )
  WHERE tracking_token_hash IS NULL;
--> statement-breakpoint
ALTER TABLE ban_appeals ALTER COLUMN tracking_token DROP NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ban_appeals_fill_tracking_token_hash() RETURNS trigger AS $$
BEGIN
  IF NEW.tracking_token_hash IS NULL AND NEW.tracking_token IS NOT NULL THEN
    NEW.tracking_token_hash := translate(
      encode(digest(NEW.tracking_token, 'sha256'), 'base64'),
      '+/=',
      '-_'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ban_appeals_fill_tracking_token_hash ON ban_appeals;
--> statement-breakpoint
CREATE TRIGGER ban_appeals_fill_tracking_token_hash
  BEFORE INSERT ON ban_appeals
  FOR EACH ROW EXECUTE FUNCTION ban_appeals_fill_tracking_token_hash();
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ban_appeals_tracking_token_hash_key ON ban_appeals (tracking_token_hash);
