-- GAME-2 (#81): team balancer review surface. Three tables in one slot.
--
-- `balancer_settings` is the singleton rules row (thresholds + the vote model
-- SquadJS owns), `balancer_proposals` caches the dry-run snapshots pushed in by
-- the upstream exporter over the HMAC webhook, and `balancer_decisions` is the
-- append-only record of what an operator decided about each snapshot.
--
-- `signals` and `proposal` are opaque jsonb versioned by `schema_version`, so a
-- change in the exporter's payload never forces another migration.
--
-- This slice adds no execution path: nothing here is ever sent to a server.
-- See packages/db/src/schema/balancer-settings.ts, balancer-proposals.ts and
-- balancer-decisions.ts.

CREATE TABLE IF NOT EXISTS balancer_settings (
  id                         smallint     PRIMARY KEY NOT NULL DEFAULT 1,
  enabled                    boolean      NOT NULL DEFAULT false,
  win_streak_threshold       integer      NOT NULL DEFAULT 3,
  ticket_diff_threshold      integer      NOT NULL DEFAULT 150,
  one_sided_rounds_threshold integer      NOT NULL DEFAULT 2,
  quorum                     integer      NOT NULL DEFAULT 5,
  pass_threshold_pct         integer      NOT NULL DEFAULT 60,
  require_moderator_veto     boolean      NOT NULL DEFAULT false,
  prefer_squad_grouping      boolean      NOT NULL DEFAULT true,
  player_level_enabled       boolean      NOT NULL DEFAULT false,
  updated_by_player_id       uuid         REFERENCES players(id) ON DELETE SET NULL,
  updated_at                 timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT balancer_settings_singleton CHECK (id = 1),
  CONSTRAINT balancer_settings_win_streak_threshold_check CHECK (win_streak_threshold >= 1),
  CONSTRAINT balancer_settings_ticket_diff_threshold_check CHECK (ticket_diff_threshold >= 0),
  CONSTRAINT balancer_settings_one_sided_rounds_threshold_check CHECK (one_sided_rounds_threshold >= 1),
  CONSTRAINT balancer_settings_quorum_check CHECK (quorum >= 0),
  CONSTRAINT balancer_settings_pass_threshold_pct_check CHECK (pass_threshold_pct >= 0 AND pass_threshold_pct <= 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS balancer_proposals (
  id                 uuid         PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  source_snapshot_id text         NOT NULL,
  server_id          uuid         NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  match_id           uuid         REFERENCES matches(id) ON DELETE SET NULL,
  layer              text,
  gamemode           text,
  mode               text         NOT NULL,
  schema_version     integer      NOT NULL DEFAULT 1,
  generated_at       timestamptz  NOT NULL,
  signals            jsonb        NOT NULL DEFAULT '{}'::jsonb,
  proposal           jsonb        NOT NULL DEFAULT '[]'::jsonb,
  status             text         NOT NULL DEFAULT 'open',
  received_at        timestamptz  NOT NULL DEFAULT now(),
  created_at         timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT balancer_proposals_mode_check CHECK (mode IN ('squad','player')),
  CONSTRAINT balancer_proposals_status_check
    CHECK (status IN ('open','reviewed','dismissed','superseded')),
  CONSTRAINT balancer_proposals_schema_version_check CHECK (schema_version >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS balancer_proposals_source_snapshot_key
  ON balancer_proposals (source_snapshot_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS balancer_proposals_server_generated_idx
  ON balancer_proposals (server_id, generated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS balancer_proposals_status_idx
  ON balancer_proposals (status, generated_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS balancer_decisions (
  id                    uuid         PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  proposal_id           uuid         NOT NULL REFERENCES balancer_proposals(id) ON DELETE CASCADE,
  decision              text         NOT NULL,
  veto_reason_kind      text,
  veto_reason           text,
  decided_by_player_id  uuid         REFERENCES players(id) ON DELETE SET NULL,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT balancer_decisions_decision_check
    CHECK (decision IN ('acknowledge','veto','dismiss')),
  CONSTRAINT balancer_decisions_veto_reason_kind_check
    CHECK (veto_reason_kind IS NULL OR veto_reason_kind IN ('seeding','event','clan_match','other')),
  CONSTRAINT balancer_decisions_veto_reason_required
    CHECK (decision <> 'veto' OR veto_reason IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS balancer_decisions_proposal_idx
  ON balancer_decisions (proposal_id, created_at DESC);
