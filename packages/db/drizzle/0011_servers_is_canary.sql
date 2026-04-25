-- =====================================================================
-- 0011 — Carry-forward migration: ensure servers.is_canary exists.
--
-- The is_canary flag was originally added on the sister branch
-- feat/rnsquadjs-migration (commit 3d9faa7). The dev/staging DB on this
-- branch has the column already, but the migration file was never
-- carried over. This migration makes feat/panel-rbac self-contained:
-- a fresh db:reset on this branch will recreate the column from
-- scratch, while existing DBs that already have the column are
-- unaffected (IF NOT EXISTS).
-- =====================================================================

BEGIN;

ALTER TABLE servers ADD COLUMN IF NOT EXISTS is_canary boolean NOT NULL DEFAULT false;

COMMIT;
