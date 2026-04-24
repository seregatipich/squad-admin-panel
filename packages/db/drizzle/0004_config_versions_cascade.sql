-- Fix: DELETE /api/v1/servers/:id fails with
--   "config_versions is append-only"
-- because the reject_mutation trigger fires on the cascaded DELETE from
-- the `servers` FK. Keep append-only for direct writes, let cascades
-- from the parent `servers` table through.
--
-- pg_trigger_depth() returns 0 for statements issued by a client, and
-- > 0 when the DELETE originates from another trigger or from a FK
-- cascade (ON DELETE CASCADE on `config_versions.server_id`). Gating
-- the rejection on depth=0 preserves the append-only invariant for
-- application code while still allowing the orphan cleanup to succeed
-- when the parent server row is removed.

DROP TRIGGER IF EXISTS config_versions_reject_delete ON config_versions;
CREATE TRIGGER config_versions_reject_delete
  BEFORE DELETE ON config_versions
  FOR EACH ROW
  WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION config_versions_reject_mutation();
