-- #78: two schema-level fixes from the packages/db security audit.
--
-- 1. player_api_tokens had no index on token_hash even though every
--    Bearer-token auth request looks tokens up by it
--    (apps/api/src/plugins/auth.ts), forcing a full table scan per request,
--    including for well-formed-but-invalid tokens. Hashes are also expected
--    to be unique per minted token, matching media_upload_tokens.token_hash.
-- 2. ban_appeals.tracking_token stored the applicant's portal secret as
--    plaintext; a database read or leak could be used directly to pull up
--    (and, through the panel side, act on) anyone's appeal. It is replaced
--    with the sha-256 hash of the same value, mirroring
--    media_upload_tokens.token_hash / player_api_tokens.token_hash. Existing
--    rows are backfilled in place with the same base64url sha-256 the API
--    now computes (packages/db/src/schema/ban-appeals.ts).
--
-- Rollback-safe: the previous release only ever compared tracking_token by
-- equality to a value it received unchanged from the public portal, so it
-- never depended on the plaintext being reversible; it would simply fail to
-- find rows created by the new release (and vice versa), same as any other
-- forward-only column rename.

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
ALTER TABLE ban_appeals ALTER COLUMN tracking_token_hash SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS ban_appeals_tracking_token_key;
--> statement-breakpoint
ALTER TABLE ban_appeals DROP COLUMN IF EXISTS tracking_token;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ban_appeals_tracking_token_hash_key ON ban_appeals (tracking_token_hash);
