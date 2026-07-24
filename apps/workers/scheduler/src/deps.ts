import type { BridgeClient } from '@squad/bridge-client';
import { type DatabaseClient, events, notifySeedSubscribers } from '@squad/db';
import {
  auditLog,
  rotationProfiles,
  rotationSchedule,
  scheduledTaskRuns,
  scheduledTasks,
  seedSchedule,
  serverSettings,
  servers,
} from '@squad/db/schema';
import {
  type EventEnvelope,
  type RconOperatorCommandName,
  rconCommandRequestSchema,
  rconCommandStream,
  STREAM_NAME,
  seedCallSentPayload,
} from '@squad/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import type {
  RotationProfileAuditEntry,
  RotationProfileEntry,
  RotationProfileTickDeps,
} from './rotation-profile-tick.js';
import type {
  RotationScheduleAuditEntry,
  RotationScheduleEntry,
  RotationScheduleTickDeps,
} from './rotation-schedule-tick.js';
import type {
  ScheduledTaskAuditEntry,
  ScheduledTaskEntry,
  ScheduledTaskRunRecord,
  ScheduledTaskTickDeps,
} from './scheduled-task-tick.js';
import type {
  SeedingLiveness,
  SeedScheduleAuditEntry,
  SeedScheduleEntry,
  SeedScheduleTickDeps,
  SendRconCommandInput,
} from './seed-schedule-tick.js';

const RCON_STREAM_MAXLEN = 500;
const SEED_CALL_COOLDOWN_SECONDS = 2 * 60 * 60;

function seedPublicHost(): string {
  const panelUrl = process.env.PANEL_PUBLIC_URL;
  if (panelUrl) {
    try {
      return new URL(panelUrl).hostname;
    } catch {
      // Fall through to the service's configured RCON host.
    }
  }
  return process.env.RCON_HOST_DEFAULT ?? '127.0.0.1';
}

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
    notifyMinutesBefore: row.notifyMinutesBefore,
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

/** Loads enabled one-off rotation changes for the scheduler tick. */
export async function loadEnabledRotationScheduleEntries(
  db: DatabaseClient,
): Promise<RotationScheduleEntry[]> {
  const rows = await db.select().from(rotationSchedule).where(eq(rotationSchedule.enabled, true));
  return rows.map((row) => ({
    id: row.id,
    serverId: row.serverId,
    scheduledAt: row.scheduledAt,
    layer: row.layer,
    mode: row.mode,
    lastExecutedAt: row.lastExecutedAt,
  }));
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

export async function writeRotationScheduleAuditEntry(
  db: DatabaseClient,
  entry: RotationScheduleAuditEntry,
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

/** Loads profiles together with each server's configured timezone. */
export async function loadRotationProfiles(db: DatabaseClient): Promise<RotationProfileEntry[]> {
  const rows = await db
    .select({
      id: rotationProfiles.id,
      serverId: rotationProfiles.serverId,
      serverTimezone: servers.timezone,
      name: rotationProfiles.name,
      weekday: rotationProfiles.weekday,
      layers: rotationProfiles.layers,
      lastAppliedAt: rotationProfiles.lastAppliedAt,
    })
    .from(rotationProfiles)
    .innerJoin(servers, eq(servers.id, rotationProfiles.serverId))
    .where(isNull(servers.deletedAt));
  return rows;
}

export async function setRotationProfileLastAppliedAt(
  db: DatabaseClient,
  profileId: string,
  appliedAt: Date,
): Promise<void> {
  await db
    .update(rotationProfiles)
    .set({ lastAppliedAt: appliedAt, updatedAt: new Date() })
    .where(eq(rotationProfiles.id, profileId));
}

export async function writeRotationProfileAuditEntry(
  db: DatabaseClient,
  entry: RotationProfileAuditEntry,
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

/**
 * Publishes the scheduled SEED-4 call once per cooldown window. The scheduler
 * has no bridge dependency, so it uses the public panel host (the deployment
 * host in the supported compose files) and the configured game port.
 */
export async function notifyScheduledSeeders(
  db: DatabaseClient,
  redis: Pick<Redis, 'set' | 'xadd' | 'publish'>,
  entry: SeedScheduleEntry,
  occurrence: Date,
): Promise<void> {
  const key = `seed:call:cooldown:${entry.serverId}`;
  const claimed = await redis.set(
    key,
    occurrence.toISOString(),
    'EX',
    SEED_CALL_COOLDOWN_SECONDS,
    'NX',
  );
  if (!claimed) return;

  const [server, settings] = await Promise.all([
    db.query.servers.findFirst({
      where: and(eq(servers.id, entry.serverId), isNull(servers.deletedAt)),
    }),
    db.query.serverSettings.findFirst({ where: eq(serverSettings.serverId, entry.serverId) }),
  ]);
  if (!server || !settings) return;

  const payload = seedCallSentPayload.parse({
    server_name: server.displayName,
    join_link: `steam://connect/${seedPublicHost()}:${settings.gamePort}`,
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
  await writeSeedScheduleAuditEntry(db, {
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
}

export function createSeedScheduleDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'get' | 'set' | 'xadd' | 'publish'>,
): Omit<SeedScheduleTickDeps, 'now' | 'diag'> {
  return {
    loadEnabledEntries: () => loadEnabledSeedScheduleEntries(db),
    isDepotUpdating: () => isDepotUpdating(redis),
    getSeedingLiveness: (serverId) => getSeedingLiveness(redis, serverId),
    sendRconCommand: (input) => sendRconCommand(redis, input),
    notifySeeders: (entry, occurrence) => notifyScheduledSeeders(db, redis, entry, occurrence),
    setLastExecutedAt: (entryId, executedAt) => setLastExecutedAt(db, entryId, executedAt),
    writeAuditEntry: (entry) => writeSeedScheduleAuditEntry(db, entry),
  };
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
    writeAuditEntry: (entry) => writeRotationScheduleAuditEntry(db, entry),
  };
}

export function createRotationProfileDeps(
  db: DatabaseClient,
  bridge: Pick<BridgeClient, 'fileRead' | 'fileAtomicWrite'>,
): Omit<RotationProfileTickDeps, 'now' | 'diag'> {
  return {
    loadProfiles: () => loadRotationProfiles(db),
    bridge,
    setLastAppliedAt: (profileId, appliedAt) =>
      setRotationProfileLastAppliedAt(db, profileId, appliedAt),
    writeAuditEntry: (entry) => writeRotationProfileAuditEntry(db, entry),
  };
}

/** Loads enabled general scheduled tasks (AUTO-2, #73) for the scheduler tick. */
export async function loadEnabledScheduledTasks(db: DatabaseClient): Promise<ScheduledTaskEntry[]> {
  const rows = await db.select().from(scheduledTasks).where(eq(scheduledTasks.enabled, true));
  return rows.map((row) => ({
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    taskType: row.taskType,
    params: row.params ?? {},
    scheduledAt: row.scheduledAt,
    recurrence: row.recurrence,
    lastExecutedAt: row.lastExecutedAt,
    createdAt: row.createdAt,
  }));
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

export async function writeScheduledTaskAuditEntry(
  db: DatabaseClient,
  entry: ScheduledTaskAuditEntry,
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

/**
 * Restarts a server via the SRV-3 container-restart mechanism — the same
 * `containerStop` + `containerStart` on `squad-<serverId>` that
 * `POST /api/v1/servers/:id/restart` performs, driven here through the host
 * bridge the scheduler already holds.
 */
export async function restartServerContainer(
  bridge: Pick<BridgeClient, 'containerStop' | 'containerStart'>,
  serverId: string,
): Promise<void> {
  const name = `squad-${serverId}`;
  await bridge.containerStop({ name, timeout_sec: 60 }).catch(() => {});
  await bridge.containerStart({ name });
}

export function createScheduledTaskDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'get' | 'xadd'>,
  bridge: Pick<BridgeClient, 'containerStop' | 'containerStart'>,
): Omit<ScheduledTaskTickDeps, 'now' | 'diag'> {
  return {
    loadEnabledTasks: () => loadEnabledScheduledTasks(db),
    isDepotUpdating: () => isDepotUpdating(redis),
    sendRconCommand: (input) => sendRconCommand(redis, input),
    restartServer: (serverId) => restartServerContainer(bridge, serverId),
    setLastExecutedAt: (taskId, executedAt) =>
      setScheduledTaskLastExecutedAt(db, taskId, executedAt),
    recordRun: (run) => recordScheduledTaskRun(db, run),
    writeAuditEntry: (entry) => writeScheduledTaskAuditEntry(db, entry),
  };
}
