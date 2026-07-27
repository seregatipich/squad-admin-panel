-- MOD-5 (#62): ban-appeal portal + handling workflow.
-- `ban_appeals` holds anonymous submissions from the public portal
-- (`POST /api/v1/public/appeals`) and the panel review queue gated on
-- `mod:unban`. Approving an appeal is an unban: it runs the MOD-2 (#59)
-- revert path (Bans.cfg line removal + `moderation_actions.reverted_at`
-- + the `moderation.unban` EVT-1 envelope), so no ban state lives here.
-- `player_id` is nullable so the portal cannot be used to enumerate which
-- SteamIDs are banned; the anti-spam partial unique index therefore keys on
-- `steam_id64`, which is always present.
-- See packages/db/src/schema/ban-appeals.ts.

CREATE TABLE IF NOT EXISTS ban_appeals (
  id                   uuid         PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  number               bigserial    NOT NULL,
  player_id            uuid         REFERENCES players(id) ON DELETE CASCADE,
  moderation_action_id uuid         REFERENCES moderation_actions(id) ON DELETE SET NULL,
  steam_id64           bigint       NOT NULL,
  body                 text         NOT NULL,
  contact              text,
  status               text         NOT NULL DEFAULT 'pending',
  handler_player_id    uuid         REFERENCES players(id) ON DELETE SET NULL,
  decision_note        text,
  internal_note        text,
  tracking_token       text         NOT NULL,
  submitter_ip         inet,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  decided_at           timestamptz,
  CONSTRAINT ban_appeals_status_enum CHECK (status IN ('pending','in_review','approved','rejected')),
  CONSTRAINT ban_appeals_body_len CHECK (char_length(body) <= 4000),
  CONSTRAINT ban_appeals_contact_len CHECK (contact IS NULL OR char_length(contact) <= 200),
  CONSTRAINT ban_appeals_decision_note_len CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000),
  CONSTRAINT ban_appeals_internal_note_len CHECK (internal_note IS NULL OR char_length(internal_note) <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ban_appeals_number_key ON ban_appeals (number);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ban_appeals_tracking_token_key ON ban_appeals (tracking_token);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ban_appeals_status_created_idx ON ban_appeals (status, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ban_appeals_player_idx ON ban_appeals (player_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ban_appeals_action_idx ON ban_appeals (moderation_action_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ban_appeals_open_steam_unique_idx
  ON ban_appeals (steam_id64) WHERE status IN ('pending','in_review');
