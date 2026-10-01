import type postgres from 'postgres';

/** Rows removed (or, for `ban_appeals`, IP addresses cleared) per statement. */
const RETENTION_BATCH_SIZE = 5_000;

/**
 * Retention windows for the unpartitioned journal tables (issue #77). Each is a
 * Postgres interval literal.
 */
export const JOURNAL_RETENTION = {
  /** Delivered alerts; undelivered ones are kept longer for investigation. */
  alertEventsDelivered: '90 days',
  alertEventsAny: '365 days',
  /** Outbox rows already relayed to their stream. */
  adminsCfgSyncOutboxRelayed: '30 days',
  scheduledTaskRuns: '90 days',
  chatCommandInvocations: '90 days',
  automationRuns: '90 days',
  /** Upload tokens after they expired or were used. */
  mediaUploadTokens: '7 days',
  /** Appeal submitter IPs after the decision, and at the latest after submission. */
  banAppealIpAfterDecision: '30 days',
  banAppealIpAfterSubmission: '90 days',
} as const;

/** Rows affected per journal table by one {@link pruneJournalTables} run. */
export type JournalPruneResult = Record<
  | 'alert_events'
  | 'admins_cfg_sync_outbox'
  | 'scheduled_task_runs'
  | 'chat_command_invocations'
  | 'automation_runs'
  | 'media_upload_tokens'
  | 'ban_appeals_submitter_ip',
  number
>;

/**
 * Repeats one batched statement until it affects fewer rows than a full batch,
 * so a large backlog is worked off without one long-running statement holding
 * row locks on the whole table.
 *
 * @returns The total number of rows affected.
 */
async function inBatches(statement: () => Promise<{ count: number }>): Promise<number> {
  let total = 0;
  for (;;) {
    const { count } = await statement();
    total += count;
    // Written so that only a full batch continues the loop: a short batch and
    // a result without a usable count both stop it.
    if (!(count >= RETENTION_BATCH_SIZE)) return total;
  }
}

/**
 * Applies {@link JOURNAL_RETENTION} to the journal tables that nothing else
 * prunes: delivered alerts, relayed Admins.cfg outbox rows, cron-task runs,
 * chat-command and automation logs, spent media upload tokens, and the IP
 * address of ban-appeal submitters (personal data of anonymous claimants).
 *
 * Rows still referenced elsewhere are kept: an alert an expiry notification
 * points at, and an upload token a stored media file points at (both foreign
 * keys are NO ACTION). Runs hourly from {@link runPartitionTick}; every
 * statement is idempotent, so an interrupted run is simply resumed next hour.
 *
 * @param sql - Connection to the panel database.
 * @returns Rows affected per table.
 * @throws The Postgres error of the first statement that fails.
 */
export async function pruneJournalTables(sql: postgres.Sql): Promise<JournalPruneResult> {
  const r = JOURNAL_RETENTION;
  return {
    alert_events: await inBatches(
      () => sql`
        DELETE FROM alert_events WHERE id IN (
          SELECT a.id FROM alert_events a
          WHERE (
              (a.delivered AND a.triggered_at < now() - ${r.alertEventsDelivered}::interval)
              OR a.triggered_at < now() - ${r.alertEventsAny}::interval
            )
            AND NOT EXISTS (SELECT 1 FROM expiry_notifications n WHERE n.alert_event_id = a.id)
          LIMIT ${RETENTION_BATCH_SIZE})`,
    ),
    admins_cfg_sync_outbox: await inBatches(
      () => sql`
        DELETE FROM admins_cfg_sync_outbox WHERE id IN (
          SELECT id FROM admins_cfg_sync_outbox
          WHERE relayed_at < now() - ${r.adminsCfgSyncOutboxRelayed}::interval
          LIMIT ${RETENTION_BATCH_SIZE})`,
    ),
    scheduled_task_runs: await inBatches(
      () => sql`
        DELETE FROM scheduled_task_runs WHERE id IN (
          SELECT id FROM scheduled_task_runs
          WHERE executed_at < now() - ${r.scheduledTaskRuns}::interval
          LIMIT ${RETENTION_BATCH_SIZE})`,
    ),
    chat_command_invocations: await inBatches(
      () => sql`
        DELETE FROM chat_command_invocations WHERE id IN (
          SELECT id FROM chat_command_invocations
          WHERE created_at < now() - ${r.chatCommandInvocations}::interval
          LIMIT ${RETENTION_BATCH_SIZE})`,
    ),
    automation_runs: await inBatches(
      () => sql`
        DELETE FROM automation_runs WHERE id IN (
          SELECT id FROM automation_runs
          WHERE fired_at < now() - ${r.automationRuns}::interval
          LIMIT ${RETENTION_BATCH_SIZE})`,
    ),
    media_upload_tokens: await inBatches(
      () => sql`
        DELETE FROM media_upload_tokens WHERE id IN (
          SELECT t.id FROM media_upload_tokens t
          WHERE (
              t.expires_at < now() - ${r.mediaUploadTokens}::interval
              OR t.used_at < now() - ${r.mediaUploadTokens}::interval
            )
            AND NOT EXISTS (SELECT 1 FROM media_files f WHERE f.upload_token_id = t.id)
          LIMIT ${RETENTION_BATCH_SIZE})`,
    ),
    ban_appeals_submitter_ip: await inBatches(
      () => sql`
        UPDATE ban_appeals SET submitter_ip = NULL WHERE id IN (
          SELECT id FROM ban_appeals
          WHERE submitter_ip IS NOT NULL
            AND (
              decided_at < now() - ${r.banAppealIpAfterDecision}::interval
              OR created_at < now() - ${r.banAppealIpAfterSubmission}::interval
            )
          LIMIT ${RETENTION_BATCH_SIZE})`,
    ),
  };
}
