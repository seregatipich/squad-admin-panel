-- Kick automation rules need a reason (#53). kickActionSchema used to default
-- `reason` to '', and worker-rcon refuses `AdminKick <target> ''`, so such a
-- rule enqueued a command that always failed while its run was recorded as
-- executed. The schema now requires a non-blank reason; this backfills the
-- rules saved under the old default so they keep firing (the engine drops a
-- rule whose action no longer validates) and actually kick.
--
-- Rollback-safe: data only. The previous release accepts any reason string.
UPDATE automation_rules
   SET action = jsonb_set(action, '{reason}', to_jsonb('Автоматический кик'::text), true),
       updated_at = now()
 WHERE action_type = 'kick'
   AND btrim(coalesce(action->>'reason', '')) = '';
