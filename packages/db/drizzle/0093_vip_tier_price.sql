-- ECON-6 (#166): privilege shop — bonus-point price on the VIP tier catalog.
-- `price_bonuses` NULL means the tier is not purchasable; a non-NULL price
-- requires `default_days` because a purchase is always a timed grant. The
-- partial index serves the shop listing (active purchasable tiers).
ALTER TABLE vip_tiers ADD COLUMN IF NOT EXISTS price_bonuses integer;
--> statement-breakpoint
ALTER TABLE vip_tiers DROP CONSTRAINT IF EXISTS vip_tiers_price_bonuses_nonneg_chk;
--> statement-breakpoint
ALTER TABLE vip_tiers
  ADD CONSTRAINT vip_tiers_price_bonuses_nonneg_chk
  CHECK (price_bonuses IS NULL OR price_bonuses >= 0);
--> statement-breakpoint
ALTER TABLE vip_tiers DROP CONSTRAINT IF EXISTS vip_tiers_price_requires_days_chk;
--> statement-breakpoint
ALTER TABLE vip_tiers
  ADD CONSTRAINT vip_tiers_price_requires_days_chk
  CHECK (price_bonuses IS NULL OR default_days IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vip_tiers_purchasable_idx
  ON vip_tiers (is_active) WHERE price_bonuses IS NOT NULL;
