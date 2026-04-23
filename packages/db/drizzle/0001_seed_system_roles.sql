-- =====================================================================
-- Seed migration: NO-OP at migration time.
--
-- System roles and their permissions are created per-organization when
-- the setup wizard calls POST /api/v1/setup/org. Seeding here would
-- create roles without an org_id (violates FK). The TS seed helper
-- lives in packages/db/src/seed/system-roles.ts and is called by API.
--
-- This file exists to reserve migration slot 0001 for the future; no
-- rows added in Phase 0 DDL migrations.
-- =====================================================================

SELECT 1;
