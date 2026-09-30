import type { Diag } from '@squad/diag';
import type { RconOperatorCommandName } from '@squad/shared-types';
import { resolveCronDueOccurrence, type SendRconCommandInput } from './due-occurrence.js';

/** One row of the `seed_schedule` table (SEED-3, #142). */
export interface SeedScheduleEntry {
  id: string;
  serverId: string;
  startsAt: Date;
  seedLayer: string;
  broadcastText: string | null;
  /** Minutes before the scheduled occurrence when subscribers are notified. */
  notifyMinutesBefore: number;
  /** 5-field cron expression, UTC. Null = one-off (fires once, at `startsAt`). */
  recurrence: string | null;
  lastExecutedAt: Date | null;
  createdAt: Date;
}

export type SeedingLiveness = 'seeding' | 'live' | 'unknown';

export interface SeedScheduleAuditEntry {
  actor: { kind: 'system'; label: 'seed-scheduler' };
  actionType:
    | 'server.seed_schedule.execute'
    | 'server.seed_schedule.skip_depot_update'
    | 'seed.call_sent';
  targetType: 'seed_schedule';
  targetId: string;
  context: Record<string, unknown>;
}

export interface SeedScheduleTickDeps {
  now?: Date;
  loadEnabledEntries(): Promise<SeedScheduleEntry[]>;
  isDepotUpdating(): Promise<boolean>;
  getSeedingLiveness(serverId: string): Promise<SeedingLiveness>;
  sendRconCommand(input: SendRconCommandInput): Promise<void>;
  /** Best-effort notification for a scheduled occurrence; must be idempotent. */
  notifySeeders?(entry: SeedScheduleEntry, occurrence: Date): Promise<void>;
  setLastExecutedAt(entryId: string, executedAt: Date): Promise<void>;
  writeAuditEntry(entry: SeedScheduleAuditEntry): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface SeedScheduleTickResult {
  executed: number;
  skippedDepotUpdate: number;
}

/**
 * Resolves the single cron/one-off occurrence (if any) due for `entry` as of
 * `now` (a one-off fires at `startsAt`); see {@link resolveCronDueOccurrence}.
 */
export function resolveDueOccurrence(entry: SeedScheduleEntry, now: Date): Date | null {
  return resolveCronDueOccurrence({ ...entry, oneOffAt: entry.startsAt }, now);
}

/**
 * Resolves the occurrence whose notification lead-time window contains `now`.
 * The runtime dependency uses a Redis cooldown to make repeated scheduler
 * ticks idempotent while the same occurrence remains inside that window.
 */
export function resolveNotificationOccurrence(entry: SeedScheduleEntry, now: Date): Date | null {
  if (entry.notifyMinutesBefore <= 0) return null;
  return resolveDueOccurrence(entry, new Date(now.getTime() + entry.notifyMinutesBefore * 60_000));
}

/**
 * SEED-3 (#142): executes every due `seed_schedule` entry — one-off entries
 * fire once at `startsAt`, recurring entries fire on each cron occurrence —
 * via the worker-rcon command stream: `AdminChangeLayer` when the server's
 * SEED-1 redis state is `seeding` (or absent/unknown, i.e. not yet observed
 * as live), `AdminSetNextLayer` when it is `live`, plus an optional
 * `AdminBroadcast` when `broadcastText` is set (best-effort: once the layer
 * change is queued a failing broadcast is only reported, never re-sent). Skips (without advancing the
 * execution cursor, so the same occurrence retries next tick) while a depot
 * update is in progress (redis `depot:updating`), auditing the skip. Every
 * execution is written to `audit_log` with actor `{kind:'system',
 * label:'seed-scheduler'}`.
 *
 * If the layer-change enqueue (or the liveness read) throws, `lastExecutedAt` is deliberately left
 * unset so the occurrence is retried on the next tick rather than silently
 * dropped.
 */
export async function runSeedScheduleTick(
  deps: SeedScheduleTickDeps,
): Promise<SeedScheduleTickResult> {
  const now = deps.now ?? new Date();
  let executed = 0;
  let skippedDepotUpdate = 0;

  try {
    const entries = await deps.loadEnabledEntries();

    for (const entry of entries) {
      const occurrence = resolveDueOccurrence(entry, now);
      const notificationOccurrence = resolveNotificationOccurrence(entry, now);
      if (notificationOccurrence && deps.notifySeeders) {
        try {
          await deps.notifySeeders(entry, notificationOccurrence);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await deps.diag.emit({
            component: 'worker-scheduler',
            kind: 'seed_schedule.notify_failed',
            severity: 'error',
            message: `seed_schedule ${entry.id} notification failed: ${message}`,
            payload: { entry_id: entry.id, server_id: entry.serverId, err: message },
          });
        }
      }
      if (!occurrence) continue;

      if (await deps.isDepotUpdating()) {
        skippedDepotUpdate++;
        await deps.writeAuditEntry({
          actor: { kind: 'system', label: 'seed-scheduler' },
          actionType: 'server.seed_schedule.skip_depot_update',
          targetType: 'seed_schedule',
          targetId: entry.id,
          context: { server_id: entry.serverId, occurrence: occurrence.toISOString() },
        });
        await deps.diag.emit({
          component: 'worker-scheduler',
          kind: 'seed_schedule.skipped_depot_update',
          severity: 'warn',
          message: `seed_schedule ${entry.id} skipped: depot update in progress`,
          payload: { entry_id: entry.id, server_id: entry.serverId },
        });
        continue;
      }

      let command: RconOperatorCommandName;
      try {
        const liveness = await deps.getSeedingLiveness(entry.serverId);
        command = liveness === 'live' ? 'AdminSetNextLayer' : 'AdminChangeLayer';
        await deps.sendRconCommand({
          serverId: entry.serverId,
          command,
          args: [entry.seedLayer],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await deps.diag.emit({
          component: 'worker-scheduler',
          kind: 'seed_schedule.rcon_failed',
          severity: 'error',
          message: `seed_schedule ${entry.id} rcon enqueue failed: ${message}`,
          payload: { entry_id: entry.id, server_id: entry.serverId, err: message },
        });
        continue;
      }

      // The layer change is queued, so the occurrence is consumed from here on.
      // A failed broadcast must not send the change again on the next tick.
      await deps.setLastExecutedAt(entry.id, occurrence);
      if (entry.broadcastText) {
        try {
          await deps.sendRconCommand({
            serverId: entry.serverId,
            command: 'AdminBroadcast',
            args: [entry.broadcastText],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await deps.diag.emit({
            component: 'worker-scheduler',
            kind: 'seed_schedule.broadcast_failed',
            severity: 'error',
            message: `seed_schedule ${entry.id} broadcast enqueue failed: ${message}`,
            payload: { entry_id: entry.id, server_id: entry.serverId, err: message },
          });
        }
      }
      await deps.writeAuditEntry({
        actor: { kind: 'system', label: 'seed-scheduler' },
        actionType: 'server.seed_schedule.execute',
        targetType: 'seed_schedule',
        targetId: entry.id,
        context: {
          server_id: entry.serverId,
          seed_layer: entry.seedLayer,
          command,
          occurrence: occurrence.toISOString(),
          broadcast: entry.broadcastText !== null,
        },
      });
      executed++;
    }

    await deps.diag.emit({
      component: 'worker-scheduler',
      kind: 'seed_schedule.run_ok',
      severity: 'info',
      message: `executed ${executed} seed_schedule entr${executed === 1 ? 'y' : 'ies'}`,
      payload: { executed, skipped_depot_update: skippedDepotUpdate },
    });
    return { executed, skippedDepotUpdate };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.diag.emit({
      component: 'worker-scheduler',
      kind: 'seed_schedule.run_failed',
      severity: 'error',
      message: `seed_schedule tick failed: ${message}`,
      payload: { err: message },
    });
    throw err;
  }
}
