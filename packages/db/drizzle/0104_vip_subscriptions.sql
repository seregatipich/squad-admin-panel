-- VIPSUB-5 (#171): recurring VIP subscriptions paid in internal ECON bonus
-- points, plus the session scope that makes player self-service safe.
--
-- `sessions.scope` defaults to 'panel', so every session minted before this
-- migration keeps exactly the authority it had. Only the Steam callback for a
-- player whose role has no `panel_access` mints 'self_service', and such a
-- session is honoured only on routes that declare `config.selfService`
-- (apps/api/src/plugins/auth.ts).
--
-- `vip_subscriptions.price_bonuses` / `renews_every_days` are snapshots taken
-- at purchase time: editing the tier catalog must never reprice a live
-- subscription. See packages/db/src/schema/vip-subscriptions.ts.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'panel';
--> statement-breakpoint
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_scope_chk;
--> statement-breakpoint
ALTER TABLE sessions
  ADD CONSTRAINT sessions_scope_chk CHECK (scope IN ('panel','self_service'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS vip_subscriptions (
  id                uuid        PRIMARY KEY NOT NULL,
  player_id         uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  tier_id           uuid        NOT NULL REFERENCES vip_tiers(id) ON DELETE RESTRICT,
  status            text        NOT NULL DEFAULT 'active',
  renews_every_days integer     NOT NULL,
  price_bonuses     integer     NOT NULL,
  next_renewal_at   timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz,
  CONSTRAINT vip_subscriptions_status_chk CHECK (status IN ('active','cancelled','expired')),
  CONSTRAINT vip_subscriptions_renews_every_days_chk CHECK (renews_every_days > 0),
  CONSTRAINT vip_subscriptions_price_bonuses_chk CHECK (price_bonuses >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vip_subscriptions_due_idx
  ON vip_subscriptions (status, next_renewal_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vip_subscriptions_player_idx
  ON vip_subscriptions (player_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS vip_subscriptions_one_active_idx
  ON vip_subscriptions (player_id) WHERE status = 'active';
