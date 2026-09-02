ALTER TABLE "players" ADD COLUMN "role_lifecycle_event_id" text;
--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_role_lifecycle_event_fk" FOREIGN KEY ("role_lifecycle_event_id") REFERENCES "public"."vip_lifecycle_events"("event_id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "vip_lifecycle_events" ADD COLUMN "revision" integer;
--> statement-breakpoint
ALTER TABLE "vip_lifecycle_events" ADD COLUMN "request_hash" text;
--> statement-breakpoint
ALTER TABLE "vip_lifecycle_events" ADD COLUMN "superseded_by_event_id" text;
--> statement-breakpoint
ALTER TABLE "vip_lifecycle_events" DROP CONSTRAINT "vip_lifecycle_events_action_chk";
--> statement-breakpoint
ALTER TABLE "vip_lifecycle_events" ADD CONSTRAINT "vip_lifecycle_events_action_chk" CHECK ("action" IN ('assigned','revoked','ignored','superseded'));
--> statement-breakpoint
ALTER TABLE "vip_lifecycle_events" ADD CONSTRAINT "vip_lifecycle_events_superseded_by_event_fk" FOREIGN KEY ("superseded_by_event_id") REFERENCES "public"."vip_lifecycle_events"("event_id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX "vip_lifecycle_events_player_revision_key" ON "vip_lifecycle_events" USING btree ("player_id", "revision") WHERE "revision" IS NOT NULL;
