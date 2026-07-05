-- AUTO-3 (#74): alert rules + alert events
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_rules_type_chk" CHECK ("type" IN ('server_crashed','unusual_activity','admin_login_new_ip','custom'))
);
--> statement-breakpoint
CREATE TABLE "alert_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"delivered" boolean DEFAULT false NOT NULL,
	CONSTRAINT "alert_events_severity_chk" CHECK ("severity" IN ('info','warning','critical'))
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_created_by_players_id_fk" FOREIGN KEY ("created_by") REFERENCES "players"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "alert_rules_enabled_idx" ON "alert_rules" USING btree ("enabled");
--> statement-breakpoint
CREATE INDEX "alert_events_rule_triggered_idx" ON "alert_events" USING btree ("rule_id","triggered_at" DESC);
--> statement-breakpoint
CREATE INDEX "alert_events_triggered_idx" ON "alert_events" USING btree ("triggered_at" DESC);
