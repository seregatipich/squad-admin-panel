ALTER TABLE "players" ADD COLUMN "role_lifecycle_event_id" text;
--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_role_lifecycle_event_fk" FOREIGN KEY ("role_lifecycle_event_id") REFERENCES "public"."vip_lifecycle_events"("event_id") ON DELETE SET NULL ON UPDATE NO ACTION;
