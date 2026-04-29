-- =====================================================================
-- 0016 — Drop legacy "Viewer" role from production seed.
--
-- Spec lists exactly six default roles (Owner, Admin, Moderator,
-- QueuePriority, Cameraman, Intern). Viewer was a 0009-era seed and
-- predates the unified role model — not part of the spec, not in the
-- editor presets, not referenced by any production code path.
--
-- Tests that depended on a "narrow read-only" role now use the
-- ensureViewerFixture() helper in apps/api/test/helpers/viewer-fixture.ts
-- which idempotently re-creates the row at test setup time. The
-- integration harness ensures it once per harness build.
--
-- Forward-only. Pre-launch.
-- =====================================================================

-- ON DELETE SET NULL on players.role_id handles any active assignment.
DELETE FROM roles WHERE name = 'Viewer' AND is_system_role = false;
