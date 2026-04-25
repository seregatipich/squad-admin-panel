-- =====================================================================
-- 0010 — Complete the multi-tenancy removal started in 0009.
--
-- 0009 dropped the organizations table with CASCADE, which removed FK
-- constraints from referencing tables but left orphaned columns/indexes
-- behind. This migration drops servers.org_id and the two composite
-- indexes that referenced it, replacing them with single-column variants
-- that match the post-RBAC schema.
--
-- Destructive forward-only. Pre-launch — no prod data to preserve.
-- =====================================================================

BEGIN;

-- servers_org_id_slug_key was created as a UNIQUE CONSTRAINT (not a plain
-- index), so it must be dropped via ALTER TABLE DROP CONSTRAINT.
-- Dropping the column also cascades the constraint drop, but being explicit
-- here makes the migration self-documenting.
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_org_id_slug_key;

-- The plain btree index on (org_id, status) can be dropped directly.
DROP INDEX IF EXISTS servers_org_status_idx;

-- Drop the orphaned column (also cascades any remaining dependent objects).
ALTER TABLE servers DROP COLUMN IF EXISTS org_id;

-- Recreate single-column indexes to match packages/db/src/schema/servers.ts.
CREATE UNIQUE INDEX IF NOT EXISTS servers_slug_key ON servers(slug);
CREATE INDEX IF NOT EXISTS servers_status_idx ON servers(status);

COMMIT;
