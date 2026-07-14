import type { DatabaseClient } from '@squad/db';
import { auditLog, seedSchedule } from '@squad/db/schema';
import {
  type RconOperatorCommandName,
  rconCommandRequestSchema,
  rconCommandStream,
} from '@squad/shared-types';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import type {
  SeedingLiveness,
  SeedScheduleAuditEntry,
  SeedScheduleEntry,
  SeedScheduleTickDeps,
  SendRconCommandInput,
} from './seed-schedule-tick.js';

const RCON_STREAM_MAXLEN = 500;

export async function loadEnabledSeedScheduleEntries(
  db: DatabaseClient,
): Promise<SeedScheduleEntry[]> {
  const rows = await db.select().from(seedSchedule).where(eq(seedSchedule.enabled, true));
  return rows.map((row) => ({
    id: row.id,
    serverId: row.serverId,
    startsAt: row.startsAt,
    seedLayer: row.seedLayer,
    broadcastText: row.broadcastText,
    recurrence: row.recurrence,
    lastExecutedAt: row.lastExecutedAt,
    createdAt: row.createdAt,
  }));
}

export async function isDepotUpdating(redis: Pick<Redis, 'get'>): Promise<boolean> {
  return (await redis.get('depot:updating')) !== null;
}

/**
 * Reads the SEED-1 (`seeding:state:<serverId>`) redis cache maintained by
 * worker-rcon's seeding state machine (`apps/workers/rcon/src/seeding.ts`).
 * Missing or unparseable state is reported as `'unknown'`, which the tick
 * treats the same as `'seeding'` (i.e. not yet confirmed live) — see
 * `runSeedScheduleTick`.
 */
export async function getSeedingLiveness(
  redis: Pick<Redis, 'get'>,
  serverId: string,
): Promise<SeedingLiveness> {
  const raw = await redis.get(`seeding:state:${serverId}`);
  if (!raw) return 'unknown';
  try {
    const parsed = JSON.parse(raw) as { state?: unknown };
    return parsed.state === 'live' ? 'live' : parsed.state === 'seeding' ? 'seeding' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Enqueues an operator RCON command onto worker-rcon's command stream. The
 * actual RCON round-trip and result polling happen in `worker-rcon`
 * (`apps/workers/rcon`) — mirrors `apps/workers/clan-guard/src/deps.ts`'s
 * `sendRconCommand`, since the API-side helper
 * (`apps/api/src/lib/rcon-worker-command.ts`) cannot be imported from a
 * worker package.
 */
export async function sendRconCommand(
  redis: Pick<Redis, 'xadd'>,
  input: SendRconCommandInput,
): Promise<void> {
  const request = rconCommandRequestSchema.parse({
    request_id: uuidv7(),
    command: input.command as RconOperatorCommandName,
    args: input.args,
    actor_player_id: null,
    enqueued_at: new Date().toISOString(),
  });
  await redis.xadd(
    rconCommandStream(input.serverId),
    'MAXLEN',
    '~',
    String(RCON_STREAM_MAXLEN),
    '*',
    'request',
    JSON.stringify(request),
  );
}

export async function setLastExecutedAt(
  db: DatabaseClient,
  entryId: string,
  executedAt: Date,
): Promise<void> {
  await db
    .update(seedSchedule)
    .set({ lastExecutedAt: executedAt, updatedAt: new Date() })
    .where(eq(seedSchedule.id, entryId));
}

export async function writeSeedScheduleAuditEntry(
  db: DatabaseClient,
  entry: SeedScheduleAuditEntry,
): Promise<void> {
  await db.insert(auditLog).values({
    actorKind: entry.actor.kind,
    actorPlayerId: null,
    actorTokenId: null,
    actorSystemLabel: entry.actor.label,
    actorIp: null,
    actionType: entry.actionType,
    targetType: entry.targetType,
    targetId: entry.targetId,
    beforeSnapshot: null,
    afterSnapshot: null,
    context: entry.context,
    statusCode: null,
    rowHash: Buffer.from([]),
  });
}

export function createSeedScheduleDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'get' | 'xadd'>,
): Omit<SeedScheduleTickDeps, 'now' | 'diag'> {
  return {
    loadEnabledEntries: () => loadEnabledSeedScheduleEntries(db),
    isDepotUpdating: () => isDepotUpdating(redis),
    getSeedingLiveness: (serverId) => getSeedingLiveness(redis, serverId),
    sendRconCommand: (input) => sendRconCommand(redis, input),
    setLastExecutedAt: (entryId, executedAt) => setLastExecutedAt(db, entryId, executedAt),
    writeAuditEntry: (entry) => writeSeedScheduleAuditEntry(db, entry),
  };
}
