-- Forward-only carry-forward: 0108 was already applied before the Admins.cfg
-- delivery-result contract was added, so its recorded hash must remain stable.
ALTER TABLE "admins_cfg_sync_outbox" ADD COLUMN IF NOT EXISTS "correlation_id" text;
--> statement-breakpoint
ALTER TABLE "admins_cfg_sync_outbox" ADD COLUMN IF NOT EXISTS "applied_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "admins_cfg_sync_outbox" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
ALTER TABLE "admins_cfg_sync_outbox" ADD COLUMN IF NOT EXISTS "reload_outcome" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admins_cfg_sync_outbox_correlation_idx" ON "admins_cfg_sync_outbox" USING btree ("correlation_id") WHERE "correlation_id" IS NOT NULL;
