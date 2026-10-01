import type { BridgeClient } from '@squad/bridge-client';
import { type DatabaseClient, events, notifySeedSubscribers } from '@squad/db';
import { seedSchedule, serverSettings, servers } from '@squad/db/schema';
import { type EventEnvelope, STREAM_NAME, seedCallSentPayload } from '@squad/shared-types';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import type {
  SeedingLiveness,
  SeedScheduleEntry,
  SeedScheduleTickDeps,
} from '../seed-schedule-tick.js';
import { isDepotUpdating, sendRconCommand, writeSystemAuditEntry } from './shared.js';

const SEED_CALL_COOLDOWN_SECONDS = 2 * 60 * 60;

/**
 * Loads the seed-schedule entries the tick can still execute: enabled
 * recurring entries, and enabled one-off entries that have not run yet.
 * Filtering executed one-offs in SQL keeps the per-tick read from growing with
 * the calendar's history; the query matches the partial index
 * `seed_schedule_active_idx`.
 */
export async function loadEnabledSeedScheduleEntries(
  db: DatabaseClient,
): Promise<SeedScheduleEntry[]> {
  const rows = await db
    .select({
      id: seedSchedule.id,
      serverId: seedSchedule.serverId,
      startsAt: seedSchedule.startsAt,
      seedLayer: seedSchedule.seedLayer,
      broadcastText: seedSchedule.broadcastText,
      notifyMinutesBefore: seedSchedule.notifyMinutesBefore,
      recurrence: seedSchedule.recurrence,
      lastExecutedAt: seedSchedule.lastExecutedAt,
      createdAt: seedSchedule.createdAt,
    })
    .from(seedSchedule)
    .innerJoin(servers, eq(servers.id, seedSchedule.serverId))
    .where(
      and(
        eq(seedSchedule.enabled, true),
        isNull(servers.deletedAt),
        or(isNotNull(seedSchedule.recurrence), isNull(seedSchedule.lastExecutedAt)),
      ),
    );
  return rows;
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

/**
 * Resolves the SEED-4 join link through the host bridge exactly like
 * `POST /api/v1/servers/:id/seed-call` does (`loadServerContext` in
 * `apps/api/src/routes/server-seed-notifications.ts`): `host_info`'s
 * `hostname`, falling back to its first `ip_addresses` entry. Returns `null`
 * when the bridge call fails or neither is set, the same "host unavailable"
 * condition the API route surfaces as a 503 rather than a broken
 * `steam://connect/127.0.0.1:...` link.
 */
async function resolveSeedJoinLink(
  bridge: Pick<BridgeClient, 'hostInfo'>,
  gamePort: number,
): Promise<string | null> {
  let host: Awaited<ReturnType<BridgeClient['hostInfo']>>;
  try {
    host = await bridge.hostInfo();
  } catch {
    return null;
  }
  const address = host.hostname || host.ip_addresses[0];
  return address ? `steam://connect/${address}:${gamePort}` : null;
}

/**
 * Publishes the scheduled SEED-4 call once per cooldown window.
 *
 * Loads the server, its settings, and the join-link host BEFORE claiming the
 * cooldown key (#1003): a deleted/misconfigured server or an unreachable
 * bridge returns early without touching Redis, so the operator's next manual
 * `POST /seed-call` is not blocked by a cooldown that was claimed but never
 * actually notified anyone. Once claimed, an error while inserting the event
 * or notifying subscribers releases the cooldown key again rather than
 * silently burning the 2-hour window with zero notifications sent.
 */
export async function notifyScheduledSeeders(
  db: DatabaseClient,
  redis: Pick<Redis, 'set' | 'xadd' | 'publish' | 'del'>,
  bridge: Pick<BridgeClient, 'hostInfo'>,
  entry: SeedScheduleEntry,
  occurrence: Date,
): Promise<void> {
  const [server, settings] = await Promise.all([
    db.query.servers.findFirst({
      where: and(eq(servers.id, entry.serverId), isNull(servers.deletedAt)),
    }),
    db.query.serverSettings.findFirst({ where: eq(serverSettings.serverId, entry.serverId) }),
  ]);
  if (!server || !settings) return;

  const joinLink = await resolveSeedJoinLink(bridge, settings.gamePort);
  if (!joinLink) return;

  const key = `seed:call:cooldown:${entry.serverId}`;
  const claimed = await redis.set(
    key,
    occurrence.toISOString(),
    'EX',
    SEED_CALL_COOLDOWN_SECONDS,
    'NX',
  );
  if (!claimed) return;

  try {
    const payload = seedCallSentPayload.parse({
      server_name: server.displayName,
      join_link: joinLink,
      seed_layer: entry.seedLayer,
      scheduled_for: occurrence.toISOString(),
      source: 'schedule',
      message: entry.broadcastText ?? 'Нужен сид',
    });
    const eventId = uuidv7();
    const ts = new Date();
    const envelope: EventEnvelope = {
      event_id: eventId,
      version: 1,
      type: 'seed.call_sent',
      server_id: entry.serverId,
      ts: ts.toISOString(),
      actor: { kind: 'system', id: null },
      correlation_id: null,
      payload,
    };
    await db.insert(events).values({
      eventId,
      serverId: entry.serverId,
      occurredAt: ts,
      kind: envelope.type,
      version: envelope.version,
      actorKind: 'system',
      actorId: null,
      correlationId: null,
      payload,
    });
    await redis.xadd(
      STREAM_NAME.eventsServer(entry.serverId),
      'MAXLEN',
      '~',
      '10000',
      '*',
      'envelope',
      JSON.stringify(envelope),
    );
    const notified = await notifySeedSubscribers(db, redis, {
      serverId: entry.serverId,
      eventKind: 'seed.call_sent',
      payload,
    });
    await writeSystemAuditEntry(db, {
      actor: { kind: 'system', label: 'seed-scheduler' },
      actionType: 'seed.call_sent',
      targetType: 'seed_schedule',
      targetId: entry.id,
      context: {
        server_id: entry.serverId,
        event_id: eventId,
        occurrence: occurrence.toISOString(),
        notified,
      },
    });
  } catch (err) {
    // The notification never went out — release the cooldown so a manual
    // seed-call or the next scheduled occurrence isn't blocked for 2 hours
    // over nothing sent.
    await redis.del(key).catch(() => undefined);
    throw err;
  }
}

export function createSeedScheduleDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'get' | 'set' | 'xadd' | 'publish' | 'del'>,
  bridge: Pick<BridgeClient, 'hostInfo'>,
): Omit<SeedScheduleTickDeps, 'now' | 'diag'> {
  return {
    loadEnabledEntries: () => loadEnabledSeedScheduleEntries(db),
    isDepotUpdating: () => isDepotUpdating(redis),
    getSeedingLiveness: (serverId) => getSeedingLiveness(redis, serverId),
    sendRconCommand: (input) => sendRconCommand(redis, input),
    notifySeeders: (entry, occurrence) =>
      notifyScheduledSeeders(db, redis, bridge, entry, occurrence),
    setLastExecutedAt: (entryId, executedAt) => setLastExecutedAt(db, entryId, executedAt),
    writeAuditEntry: (entry) => writeSystemAuditEntry(db, entry),
  };
}
