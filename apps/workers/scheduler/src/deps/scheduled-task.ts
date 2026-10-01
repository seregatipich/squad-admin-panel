import type { BridgeClient } from '@squad/bridge-client';
import type { DatabaseClient } from '@squad/db';
import { chatMessages, scheduledTaskRuns, scheduledTasks, servers } from '@squad/db/schema';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type Redis from 'ioredis';
import {
  PermanentTaskDispatchError,
  type ScheduledBroadcastEcho,
  type ScheduledTaskEntry,
  type ScheduledTaskRunRecord,
  type ScheduledTaskTickDeps,
} from '../scheduled-task-tick.js';
import { isDepotUpdating, sendRconCommand, writeSystemAuditEntry } from './shared.js';

/** Loads enabled general scheduled tasks (AUTO-2, #73) for the scheduler tick, excluding soft-deleted servers. */
export async function loadEnabledScheduledTasks(db: DatabaseClient): Promise<ScheduledTaskEntry[]> {
  const rows = await db
    .select({
      id: scheduledTasks.id,
      serverId: scheduledTasks.serverId,
      serverName: servers.displayName,
      name: scheduledTasks.name,
      taskType: scheduledTasks.taskType,
      params: scheduledTasks.params,
      scheduledAt: scheduledTasks.scheduledAt,
      recurrence: scheduledTasks.recurrence,
      lastExecutedAt: scheduledTasks.lastExecutedAt,
      rotationIndex: scheduledTasks.rotationIndex,
      createdBy: scheduledTasks.createdBy,
      createdAt: scheduledTasks.createdAt,
    })
    .from(scheduledTasks)
    .innerJoin(servers, eq(servers.id, scheduledTasks.serverId))
    .where(and(eq(scheduledTasks.enabled, true), isNull(servers.deletedAt)));
  return rows.map((row) => ({ ...row, params: row.params ?? {} }));
}

/** Advances a scheduled task's execution cursor after a successful dispatch. */
export async function setScheduledTaskLastExecutedAt(
  db: DatabaseClient,
  taskId: string,
  executedAt: Date,
): Promise<void> {
  await db
    .update(scheduledTasks)
    .set({ lastExecutedAt: executedAt, updatedAt: new Date() })
    .where(eq(scheduledTasks.id, taskId));
}

/** Advances a rotating broadcast's cursor to `nextIndex` (MSG-4, #187). */
export async function setScheduledTaskRotationIndex(
  db: DatabaseClient,
  taskId: string,
  nextIndex: number,
): Promise<void> {
  await db
    .update(scheduledTasks)
    .set({ rotationIndex: nextIndex, updatedAt: new Date() })
    .where(eq(scheduledTasks.id, taskId));
}

/**
 * Records a scheduled broadcast in `chat_messages` the same way the MSG-3
 * messaging route does — scope `broadcast`, source `panel`, authored by the
 * task's creator (`created_by`). Skipped by the tick when the task has no
 * author, since `chat_messages.player_id` is NOT NULL.
 */
export async function echoScheduledBroadcast(
  db: DatabaseClient,
  echo: ScheduledBroadcastEcho,
): Promise<void> {
  await db.insert(chatMessages).values({
    playerId: echo.authorPlayerId,
    serverId: echo.serverId,
    scope: 'broadcast',
    source: 'panel',
    message: echo.message,
    sentAt: echo.sentAt,
  });
}

/** Appends one execution-history row to `scheduled_task_runs`. */
export async function recordScheduledTaskRun(
  db: DatabaseClient,
  run: ScheduledTaskRunRecord,
): Promise<void> {
  await db.insert(scheduledTaskRuns).values({
    taskId: run.taskId,
    executedAt: run.executedAt,
    status: run.status,
    detail: run.detail,
  });
}

/**
 * Restarts a server via the SRV-3 container-restart mechanism — the same
 * `containerStop` + `containerStart` on `squad-<serverId>` that
 * `POST /api/v1/servers/:id/restart` performs, driven here through the host
 * bridge the scheduler already holds.
 *
 * A failed `containerStop` is tolerated only when `containerInspect` confirms
 * the container is no longer running; otherwise the stop error is rethrown,
 * because Docker's `start` on a still-running container is a silent no-op and
 * the run would be recorded as a successful restart that never happened
 * (#1002). This matches the API route's stop-failure handling.
 *
 * It does NOT reproduce the rest of that route: it does not publish to
 * `liveBus` (the scheduler worker has no websocket fan-out) or call
 * `relaunchSidecar` (API-only `apps/api/src/lib` logic worker packages do not
 * import — see `docs/development/conventions.md`), so a sidecar stopped
 * manually before the scheduled restart stays down. The `servers.status`
 * flip to `'starting'` is done by the caller, `createScheduledTaskDeps`.
 *
 * @throws The `containerStop` error when the container may still be running,
 *   or the `containerStart` error.
 */
export async function restartServerContainer(
  bridge: Pick<BridgeClient, 'containerStop' | 'containerStart' | 'containerInspect'>,
  serverId: string,
): Promise<void> {
  const name = `squad-${serverId}`;
  try {
    await bridge.containerStop({ name, timeout_sec: 60 });
  } catch (stopError) {
    const after = await bridge.containerInspect({ name }).catch(() => null);
    if (after?.running !== false) throw stopError;
  }
  await bridge.containerStart({ name });
}

/** Deletes `scheduled_task_runs` history older than `olderThan` (#1016). */
export async function pruneScheduledTaskRuns(db: DatabaseClient, olderThan: Date): Promise<void> {
  await db.delete(scheduledTaskRuns).where(lt(scheduledTaskRuns.executedAt, olderThan));
}

export function createScheduledTaskDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'get' | 'xadd'>,
  bridge: Pick<BridgeClient, 'containerStop' | 'containerStart' | 'containerInspect'>,
): Omit<ScheduledTaskTickDeps, 'now' | 'diag'> {
  return {
    retries: new Map(),
    loadEnabledTasks: () => loadEnabledScheduledTasks(db),
    isDepotUpdating: () => isDepotUpdating(redis),
    sendRconCommand: (input) => sendRconCommand(redis, input),
    restartServer: async (serverId) => {
      // A scheduled restart drives the panel's own container; an external
      // server's process is not ours to bounce, and a soft-deleted server's
      // container is gone too, so both are recorded as failed instead of
      // retrying forever against a non-existent container.
      const row = await db.query.servers.findFirst({
        where: and(eq(servers.id, serverId), isNull(servers.deletedAt)),
        columns: { runtime: true },
      });
      if (!row) {
        throw new PermanentTaskDispatchError(
          `server ${serverId} not found or deleted: restart is not available`,
        );
      }
      if (row.runtime === 'external') {
        throw new PermanentTaskDispatchError(
          `server ${serverId} is external: restart is not available`,
        );
      }
      await restartServerContainer(bridge, serverId);
      await db
        .update(servers)
        .set({ status: 'starting', updatedAt: new Date() })
        .where(eq(servers.id, serverId));
    },
    setLastExecutedAt: (taskId, executedAt) =>
      setScheduledTaskLastExecutedAt(db, taskId, executedAt),
    advanceRotationIndex: (taskId, nextIndex) =>
      setScheduledTaskRotationIndex(db, taskId, nextIndex),
    echoBroadcastToChat: (echo) => echoScheduledBroadcast(db, echo),
    recordRun: (run) => recordScheduledTaskRun(db, run),
    writeAuditEntry: (entry) => writeSystemAuditEntry(db, entry),
  };
}
