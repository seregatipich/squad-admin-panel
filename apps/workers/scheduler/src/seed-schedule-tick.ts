import type { Diag } from '@squad/diag';
import { expandCron5Occurrences, type RconOperatorCommandName } from '@squad/shared-types';

/** One row of the `seed_schedule` table (SEED-3, #142). */
export interface SeedScheduleEntry {
  id: string;
  serverId: string;
  startsAt: Date;
  seedLayer: string;
  broadcastText: string | null;
  /** 5-field cron expression, UTC. Null = one-off (fires once, at `startsAt`). */
  recurrence: string | null;
  lastExecutedAt: Date | null;
  createdAt: Date;
}

export type SeedingLiveness = 'seeding' | 'live' | 'unknown';

export interface SendRconCommandInput {
  serverId: string;
  command: RconOperatorCommandName;
  args: string[];
}

export interface SeedScheduleAuditEntry {
  actor: { kind: 'system'; label: 'seed-scheduler' };
  actionType: 'server.seed_schedule.execute' | 'server.seed_schedule.skip_depot_update';
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
  setLastExecutedAt(entryId: string, executedAt: Date): Promise<void>;
  writeAuditEntry(entry: SeedScheduleAuditEntry): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface SeedScheduleTickResult {
  executed: number;
  skippedDepotUpdate: number;
}

/**
 * Resolves the single cron/one-off occurrence (if any) that is due for
 * `entry` as of `now`, or `null` when nothing is due.
 *
 * - One-off (`recurrence === null`): due once `startsAt <= now`, and only if
 *   it has never executed (`lastExecutedAt === null`).
 * - Recurring: due when {@link expandCron5Occurrences} finds at least one
 *   matching minute strictly after the last-known cursor
 *   (`lastExecutedAt`, or `createdAt` if it has never executed) and at or
 *   before `now`. When multiple occurrences were missed between ticks, only
 *   the most recent is returned — the tick fires once, advancing the cursor
 *   past every missed occurrence at once, rather than replaying each one.
 */
export function resolveDueOccurrence(entry: SeedScheduleEntry, now: Date): Date | null {
  if (entry.recurrence === null) {
    if (entry.lastExecutedAt !== null) return null;
    return entry.startsAt.getTime() <= now.getTime() ? entry.startsAt : null;
  }

  const hasPriorOccurrence = entry.lastExecutedAt !== null;
  const cursor = entry.lastExecutedAt ?? entry.createdAt;
  // The prior cursor (when it is itself a previously-fired occurrence) must
  // be excluded from the scan window, or the same minute would re-match.
  const from = hasPriorOccurrence ? new Date(cursor.getTime() + 60_000) : cursor;
  if (from.getTime() > now.getTime()) return null;

  const occurrences = expandCron5Occurrences(entry.recurrence, from, now);
  return occurrences.length > 0 ? (occurrences.at(-1) ?? null) : null;
}

/**
 * SEED-3 (#142): executes every due `seed_schedule` entry — one-off entries
 * fire once at `startsAt`, recurring entries fire on each cron occurrence —
 * via the worker-rcon command stream: `AdminChangeLayer` when the server's
 * SEED-1 redis state is `seeding` (or absent/unknown, i.e. not yet observed
 * as live), `AdminSetNextLayer` when it is `live`, plus an optional
 * `AdminBroadcast` when `broadcastText` is set. Skips (without advancing the
 * execution cursor, so the same occurrence retries next tick) while a depot
 * update is in progress (redis `depot:updating`), auditing the skip. Every
 * execution is written to `audit_log` with actor `{kind:'system',
 * label:'seed-scheduler'}`.
 *
 * If the RCON enqueue itself throws, `lastExecutedAt` is deliberately left
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

      const liveness = await deps.getSeedingLiveness(entry.serverId);
      const command: RconOperatorCommandName =
        liveness === 'live' ? 'AdminSetNextLayer' : 'AdminChangeLayer';

      try {
        await deps.sendRconCommand({
          serverId: entry.serverId,
          command,
          args: [entry.seedLayer],
        });
        if (entry.broadcastText) {
          await deps.sendRconCommand({
            serverId: entry.serverId,
            command: 'AdminBroadcast',
            args: [entry.broadcastText],
          });
        }
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

      await deps.setLastExecutedAt(entry.id, occurrence);
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
