-- WL-3 (#67): public whitelist/VIP application portal + approval workflow.
-- `whitelist_applications` holds public/panel submissions; approving a pending
-- row grants the resolved role to the matching players row (reusing the
-- VIPSUB-1 role_expires_at / worker-role-expirer machinery for auto-expiry).
-- panel_meta gains the portal master switch + default grant term.
-- See packages/db/src/schema/whitelist-applications.ts and panel-meta.ts.

ALTER TABLE panel_meta
  ADD COLUMN IF NOT EXISTS whitelist_applications_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE panel_meta
  ADD COLUMN IF NOT EXISTS whitelist_application_default_days integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS whitelist_applications (
  id                 uuid         PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  steam_id64         bigint       NOT NULL,
  player_id          uuid         REFERENCES players(id) ON DELETE SET NULL,
  contact            text,
  body               text         NOT NULL,
  requested_role_id  uuid         REFERENCES roles(id) ON DELETE SET NULL,
  status             text         NOT NULL DEFAULT 'pending',
  reviewer_player_id uuid         REFERENCES players(id) ON DELETE SET NULL,
  review_note        text,
  granted_role_id    uuid         REFERENCES roles(id) ON DELETE SET NULL,
  granted_until      timestamptz,
  source             text         NOT NULL DEFAULT 'public',
  created_at         timestamptz  NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  CONSTRAINT whitelist_applications_status_enum CHECK (status IN ('pending','approved','rejected')),
  CONSTRAINT whitelist_applications_source_enum CHECK (source IN ('public','panel'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS whitelist_applications_status_created_idx
  ON whitelist_applications (status, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS whitelist_applications_steam_id64_idx
  ON whitelist_applications (steam_id64);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS whitelist_applications_pending_steam_unique_idx
  ON whitelist_applications (steam_id64) WHERE status = 'pending';
--> statement-breakpoint
