-- SRV-6 (#45): the panel now writes License.cfg from server settings.
-- server_credentials.license_updated_at records when the stored license last
-- changed so the API can derive a state-based "restart required" badge
-- (License.cfg is requires_restart — the license applies only after the
-- container restarts). See packages/db/src/schema/server-credentials.ts.

ALTER TABLE server_credentials ADD COLUMN IF NOT EXISTS license_updated_at timestamptz;
--> statement-breakpoint
