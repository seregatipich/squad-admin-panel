import type { Diag } from '@squad/diag';
import { expandCron5Occurrences, type RconOperatorCommandName } from '@squad/shared-types';

/** Server action a scheduled task performs when it becomes due (AUTO-2, #73). */
export type ScheduledTaskType = 'restart' | 'set_next_layer' | 'change_layer' | 'broadcast';

/** Structured parameters carried by a task, discriminated by `taskType`. */
export interface ScheduledTaskParams {
  layer?: string;
  message?: string;
  /** Ordered rotation of broadcast texts (MSG-4, #187); overrides `message` when present. */
  messages?: string[];
  templateIds?: string[];
}

/** One enabled row of the `scheduled_tasks` table. */
export interface ScheduledTaskEntry {
  id: string;
  serverId: string;
  name: string;
  taskType: ScheduledTaskType;
  params: ScheduledTaskParams;
  /** One-off execution instant; null when the task is purely recurring. */
  scheduledAt: Date | null;
  /** 5-field cron expression, UTC. Null = one-off. */
  recurrence: string | null;
  lastExecutedAt: Date | null;
  /** Index into `params.messages` that fires next for a rotating broadcast (MSG-4, #187). */
  rotationIndex: number;
  /** Player who created the task; the author of the chat echo. Null → echo skipped. */
  createdBy: string | null;
  createdAt: Date;
}

export interface SendRconCommandInput {
  serverId: string;
  command: RconOperatorCommandName;
  args: string[];
}

export type ScheduledTaskRunStatus = 'executed' | 'skipped_depot_update' | 'failed';

export interface ScheduledTaskRunRecord {
  taskId: string;
  executedAt: Date;
  status: ScheduledTaskRunStatus;
  detail: Record<string, unknown>;
}

export interface ScheduledTaskAuditEntry {
  actor: { kind: 'system'; label: 'task-scheduler' };
  actionType: 'server.scheduled_task.execute' | 'server.scheduled_task.skip_depot_update';
  targetType: 'scheduled_task';
  targetId: string;
  context: Record<string, unknown>;
}

/** Echo of a scheduled broadcast into `chat_messages` (MSG-3/MSG-4). */
export interface ScheduledBroadcastEcho {
  serverId: string;
  authorPlayerId: string;
  message: string;
  sentAt: Date;
}

export interface ScheduledTaskTickDeps {
  now?: Date;
  loadEnabledTasks(): Promise<ScheduledTaskEntry[]>;
  isDepotUpdating(): Promise<boolean>;
  sendRconCommand(input: SendRconCommandInput): Promise<void>;
  /** Restarts a server via the SRV-3 container-restart mechanism. */
  restartServer(serverId: string): Promise<void>;
  setLastExecutedAt(taskId: string, executedAt: Date): Promise<void>;
  /** Advances a rotating broadcast's cursor after a successful dispatch (MSG-4, #187). */
  advanceRotationIndex(taskId: string, nextIndex: number): Promise<void>;
  /** Records a scheduled broadcast in `chat_messages` (scope broadcast, source panel). */
  echoBroadcastToChat(echo: ScheduledBroadcastEcho): Promise<void>;
  recordRun(run: ScheduledTaskRunRecord): Promise<void>;
  writeAuditEntry(entry: ScheduledTaskAuditEntry): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface ScheduledTaskTickResult {
  executed: number;
  skippedDepotUpdate: number;
  failed: number;
}

/**
 * Resolves the single cron/one-off occurrence (if any) that is due for `entry`
 * as of `now`, or `null` when nothing is due. Mirrors
 * `seed-schedule-tick.ts`'s `resolveDueOccurrence`:
 *
 * - Recurring (`recurrence !== null`): due when {@link expandCron5Occurrences}
 *   finds at least one matching minute strictly after the last-known cursor
 *   (`lastExecutedAt`, or `createdAt` if never executed) and at or before
 *   `now`. Multiple missed occurrences collapse to the most recent — the tick
 *   fires once and advances the cursor past all of them.
 * - One-off (`recurrence === null`, `scheduledAt` set): due once
 *   `scheduledAt <= now`, and only while it has never executed.
 * - Neither set: never due (the DB check constraint forbids this, but a stale
 *   row is treated defensively).
 */
export function resolveDueOccurrence(entry: ScheduledTaskEntry, now: Date): Date | null {
  if (entry.recurrence === null) {
    if (entry.scheduledAt === null) return null;
    if (entry.lastExecutedAt !== null) return null;
    return entry.scheduledAt.getTime() <= now.getTime() ? entry.scheduledAt : null;
  }

  const hasPriorOccurrence = entry.lastExecutedAt !== null;
  const cursor = entry.lastExecutedAt ?? entry.createdAt;
  const from = hasPriorOccurrence ? new Date(cursor.getTime() + 60_000) : cursor;
  if (from.getTime() > now.getTime()) return null;

  const occurrences = expandCron5Occurrences(entry.recurrence, from, now);
  return occurrences.length > 0 ? (occurrences.at(-1) ?? null) : null;
}

/**
 * Dispatches the RCON/restart action for a task. Restart uses the SRV-3
 * container-restart boundary (`deps.restartServer`); the layer and broadcast
 * types enqueue the corresponding operator command on worker-rcon's stream.
 * Throws when a layer/broadcast task is missing its required `params` value —
 * the caller records that as a `failed` run.
 */
async function dispatchTask(
  entry: ScheduledTaskEntry,
  deps: ScheduledTaskTickDeps,
): Promise<{ command: string; broadcast?: { text: string; listLength: number } }> {
  switch (entry.taskType) {
    case 'restart':
      await deps.restartServer(entry.serverId);
      return { command: 'restart' };
    case 'set_next_layer':
    case 'change_layer': {
      const layer = entry.params.layer;
      if (!layer)
        throw new Error(`scheduled_task ${entry.id} (${entry.taskType}) is missing a layer`);
      const command: RconOperatorCommandName =
        entry.taskType === 'change_layer' ? 'AdminChangeLayer' : 'AdminSetNextLayer';
      await deps.sendRconCommand({ serverId: entry.serverId, command, args: [layer] });
      return { command };
    }
    case 'broadcast': {
      // MSG-4 (#187): a rotating broadcast carries `messages`; a legacy single
      // broadcast carries `message`. Fire the entry at the current cursor.
      const list = entry.params.messages ?? (entry.params.message ? [entry.params.message] : []);
      if (list.length === 0)
        throw new Error(`scheduled_task ${entry.id} (broadcast) is missing a message`);
      const text = list[entry.rotationIndex % list.length];
      if (text === undefined)
        throw new Error(`scheduled_task ${entry.id} (broadcast) has no message at rotation cursor`);
      await deps.sendRconCommand({
        serverId: entry.serverId,
        command: 'AdminBroadcast',
        args: [text],
      });
      return { command: 'AdminBroadcast', broadcast: { text, listLength: list.length } };
    }
  }
}

/**
 * AUTO-2 (#73): executes every due `scheduled_tasks` row — one-off tasks fire
 * once at `scheduledAt`, recurring tasks fire on each cron occurrence — by
 * restarting the server (SRV-3) or enqueuing an operator RCON command
 * (`AdminSetNextLayer`/`AdminChangeLayer`/`AdminBroadcast`). Every attempt is
 * appended to `scheduled_task_runs` via `recordRun`.
 *
 * While a depot update is in progress (redis `depot:updating`) a due task is
 * skipped without advancing its cursor (so it retries next tick), recorded as
 * `skipped_depot_update`, and audited. When dispatch throws, the run is
 * recorded as `failed` and the cursor is likewise left unset so the occurrence
 * retries rather than being silently dropped. Successful executions advance the
 * cursor and write an `audit_log` entry with actor
 * `{kind:'system', label:'task-scheduler'}`.
 */
export async function runScheduledTaskTick(
  deps: ScheduledTaskTickDeps,
): Promise<ScheduledTaskTickResult> {
  const now = deps.now ?? new Date();
  let executed = 0;
  let skippedDepotUpdate = 0;
  let failed = 0;

  try {
    for (const entry of await deps.loadEnabledTasks()) {
      const occurrence = resolveDueOccurrence(entry, now);
      if (!occurrence) continue;

      if (await deps.isDepotUpdating()) {
        skippedDepotUpdate++;
        await deps.recordRun({
          taskId: entry.id,
          executedAt: now,
          status: 'skipped_depot_update',
          detail: { occurrence: occurrence.toISOString(), task_type: entry.taskType },
        });
        await deps.writeAuditEntry({
          actor: { kind: 'system', label: 'task-scheduler' },
          actionType: 'server.scheduled_task.skip_depot_update',
          targetType: 'scheduled_task',
          targetId: entry.id,
          context: { server_id: entry.serverId, occurrence: occurrence.toISOString() },
        });
        await deps.diag.emit({
          component: 'worker-scheduler',
          kind: 'scheduled_task.skipped_depot_update',
          severity: 'warn',
          message: `scheduled_task ${entry.id} skipped: depot update in progress`,
          payload: { task_id: entry.id, server_id: entry.serverId },
        });
        continue;
      }

      let command: string;
      let broadcast: { text: string; listLength: number } | undefined;
      try {
        ({ command, broadcast } = await dispatchTask(entry, deps));
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        await deps.recordRun({
          taskId: entry.id,
          executedAt: now,
          status: 'failed',
          detail: {
            occurrence: occurrence.toISOString(),
            task_type: entry.taskType,
            error: message,
          },
        });
        await deps.diag.emit({
          component: 'worker-scheduler',
          kind: 'scheduled_task.dispatch_failed',
          severity: 'error',
          message: `scheduled_task ${entry.id} dispatch failed: ${message}`,
          payload: { task_id: entry.id, server_id: entry.serverId, err: message },
        });
        continue;
      }

      await deps.setLastExecutedAt(entry.id, occurrence);

      const detail: Record<string, unknown> = {
        occurrence: occurrence.toISOString(),
        task_type: entry.taskType,
        command,
      };

      // MSG-4 (#187): advance the rotation cursor and echo the broadcast into
      // chat. Both run only after the RCON dispatch succeeded; an echo failure
      // is logged but never downgrades the already-executed run.
      if (broadcast) {
        detail.message = broadcast.text;
        if (broadcast.listLength > 1) {
          await deps.advanceRotationIndex(
            entry.id,
            (entry.rotationIndex + 1) % broadcast.listLength,
          );
        }
        if (entry.createdBy !== null) {
          try {
            await deps.echoBroadcastToChat({
              serverId: entry.serverId,
              authorPlayerId: entry.createdBy,
              message: broadcast.text,
              sentAt: now,
            });
            detail.echo = 'sent';
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            detail.echo = 'failed';
            detail.echo_error = message;
            await deps.diag.emit({
              component: 'worker-scheduler',
              kind: 'scheduled_task.echo_failed',
              severity: 'warn',
              message: `scheduled_task ${entry.id} broadcast echo failed: ${message}`,
              payload: { task_id: entry.id, server_id: entry.serverId, err: message },
            });
          }
        } else {
          detail.echo = 'skipped_no_author';
        }
      }

      await deps.recordRun({
        taskId: entry.id,
        executedAt: now,
        status: 'executed',
        detail,
      });
      await deps.writeAuditEntry({
        actor: { kind: 'system', label: 'task-scheduler' },
        actionType: 'server.scheduled_task.execute',
        targetType: 'scheduled_task',
        targetId: entry.id,
        context: {
          server_id: entry.serverId,
          task_type: entry.taskType,
          command,
          occurrence: occurrence.toISOString(),
        },
      });
      executed++;
    }

    await deps.diag.emit({
      component: 'worker-scheduler',
      kind: 'scheduled_task.run_ok',
      severity: 'info',
      message: `executed ${executed} scheduled task${executed === 1 ? '' : 's'}`,
      payload: { executed, skipped_depot_update: skippedDepotUpdate, failed },
    });
    return { executed, skippedDepotUpdate, failed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.diag.emit({
      component: 'worker-scheduler',
      kind: 'scheduled_task.run_failed',
      severity: 'error',
      message: `scheduled task tick failed: ${message}`,
      payload: { err: message },
    });
    throw err;
  }
}
