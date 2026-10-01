import type { DatabaseClient } from '@squad/db';
import { rotationSchedule, servers } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { RotationScheduleEntry, RotationScheduleTickDeps } from '../rotation-schedule-tick.js';
import { isDepotUpdating, sendRconCommand, writeSystemAuditEntry } from './shared.js';

/**
 * Loads the enabled one-off rotation changes that have not run yet, excluding soft-deleted servers. Executed
 * entries stay enabled for the calendar's history, so they are filtered here
 * rather than re-read every tick; the query matches the partial index
 * `rotation_schedule_pending_idx`.
 */
export async function loadEnabledRotationScheduleEntries(
  db: DatabaseClient,
): Promise<RotationScheduleEntry[]> {
  const rows = await db
    .select({
      id: rotationSchedule.id,
      serverId: rotationSchedule.serverId,
      scheduledAt: rotationSchedule.scheduledAt,
      layer: rotationSchedule.layer,
      mode: rotationSchedule.mode,
      lastExecutedAt: rotationSchedule.lastExecutedAt,
    })
    .from(rotationSchedule)
    .innerJoin(servers, eq(servers.id, rotationSchedule.serverId))
    .where(
      and(
        eq(rotationSchedule.enabled, true),
        isNull(rotationSchedule.lastExecutedAt),
        isNull(servers.deletedAt),
      ),
    );
  return rows;
}

/** Advances a rotation schedule cursor only after its RCON request is queued. */
export async function setRotationScheduleLastExecutedAt(
  db: DatabaseClient,
  entryId: string,
  executedAt: Date,
): Promise<void> {
  await db
    .update(rotationSchedule)
    .set({ lastExecutedAt: executedAt, updatedAt: new Date() })
    .where(eq(rotationSchedule.id, entryId));
}

export function createRotationScheduleDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'get' | 'xadd'>,
): Omit<RotationScheduleTickDeps, 'now' | 'diag'> {
  return {
    loadEnabledEntries: () => loadEnabledRotationScheduleEntries(db),
    isDepotUpdating: () => isDepotUpdating(redis),
    sendRconCommand: (input) => sendRconCommand(redis, input),
    setLastExecutedAt: (entryId, executedAt) =>
      setRotationScheduleLastExecutedAt(db, entryId, executedAt),
    writeAuditEntry: (entry) => writeSystemAuditEntry(db, entry),
    auditedDepotSkips: new Set<string>(),
  };
}
