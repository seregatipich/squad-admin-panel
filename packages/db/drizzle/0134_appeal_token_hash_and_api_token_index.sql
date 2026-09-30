-- Token hashes at rest (#78, #1084).
--
-- 1. player_api_tokens had no index on token_hash even though every
--    Bearer-token auth request looks tokens up by it
--    (apps/api/src/plugins/auth.ts), forcing a full table scan per request,
--    including for well-formed-but-invalid tokens. Hashes are also unique per
--    minted token, matching media_upload_tokens.token_hash.
--
-- 2. ban_appeals.tracking_token stored the applicant's portal secret as
--    plaintext, so a database read or leak could pull up anyone's appeal. Only
--    the sha256 hex of the token (tracking_token_hash, like
--    media_upload_tokens.token_hash) is stored now. Existing tokens are hashed
--    and their plaintext cleared.
--
-- Rollback-safe (expand step): the tracking_token column and its unique index
-- stay in place, relaxed to nullable, so the previous release's INSERT (which
-- names only tracking_token) still works: the BEFORE INSERT/UPDATE trigger
-- derives the hash from a plaintext token and clears the plaintext, so no
-- plaintext is stored even after a rollback. That release's status page looks
-- tokens up by plaintext and reports "not found" until the next roll forward.
-- Dropping tracking_token, its index and the trigger belongs to a later
-- release.
CREATE UNIQUE INDEX IF NOT EXISTS player_api_tokens_token_hash_key
  ON player_api_tokens (token_hash);
--> statement-breakpoint
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
