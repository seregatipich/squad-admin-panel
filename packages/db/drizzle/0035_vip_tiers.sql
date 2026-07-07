-- VIPSUB-3 (#169): VIP privilege tiers catalog. Each tier maps to an existing
-- RBAC role; granting a tier grants its role via VIPSUB-1 (with the tier's
-- default duration). Roles backing a tier cannot be deleted (ON DELETE RESTRICT).
CREATE TABLE IF NOT EXISTS vip_tiers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  description text,
  default_days integer,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vip_tiers_default_days_positive
    CHECK (default_days IS NULL OR default_days > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS vip_tiers_name_key ON vip_tiers (name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vip_tiers_role_id_idx ON vip_tiers (role_id);
