import type { BridgeClient } from '@squad/bridge-client';
import { type DatabaseClient, events, notifySeedSubscribers } from '@squad/db';
import {
  auditLog,
  chatMessages,
  layers,
  mapVoteCandidates,
  mapVotePicks,
  matches,
  rotationProfiles,
  rotationSchedule,
  scheduledTaskRuns,
  scheduledTasks,
  seasons,
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
import { and, desc, eq, isNull } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import type {
  MapVoteAuditEntry,
  MapVoteCandidateEntry,
  MapVoteServerEntry,
  MapVoteTickDeps,
} from './map-vote-tick.js';
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
  ScheduledBroadcastEcho,
  ScheduledTaskAuditEntry,
  ScheduledTaskEntry,
  ScheduledTaskRunRecord,
  ScheduledTaskTickDeps,
} from './scheduled-task-tick.js';
import type {
  ActiveSeason,
  SeasonFinalizeAuditEntry,
  SeasonFinalizeTickDeps,
} from './season-finalize-tick.js';
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
 * worker package. `requestId` lets an idempotent caller (the GAME-1 map-vote
 * tick) pin a deterministic request id; omitted, a fresh uuidv7 is used.
 */
export async function sendRconCommand(
  redis: Pick<Redis, 'xadd'>,
  input: SendRconCommandInput,
  requestId?: string,
): Promise<void> {
  const request = rconCommandRequestSchema.parse({
    request_id: requestId ?? uuidv7(),
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

/** Loads servers with GAME-1 (#80) map auto-selection enabled. */
export async function loadEnabledMapVoteServers(db: DatabaseClient): Promise<MapVoteServerEntry[]> {
  return db
    .select({
      serverId: serverSettings.serverId,
      selection: serverSettings.mapVoteSelection,
      layerCooldown: serverSettings.mapVoteLayerCooldown,
      mapCooldown: serverSettings.mapVoteMapCooldown,
    })
    .from(serverSettings)
    .innerJoin(servers, eq(servers.id, serverSettings.serverId))
    .where(and(eq(serverSettings.mapVoteEnabled, true), isNull(servers.deletedAt)));
}

/** Newest match (open or finished) for a server — the GAME-1 dedup anchor. */
export async function getLatestMatchForMapVote(
  db: DatabaseClient,
  serverId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: matches.id })
    .from(matches)
    .where(eq(matches.serverId, serverId))
    .orderBy(desc(matches.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function hasMapVotePickForMatch(
  db: DatabaseClient,
  matchId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: mapVotePicks.id })
    .from(mapVotePicks)
    .where(eq(mapVotePicks.matchId, matchId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Candidate pool joined against the `layers` catalog for map/deprecated
 * metadata. Rows whose layer left the catalog drop out (they could never be
 * validated for `AdminSetNextLayer` anyway).
 */
export async function loadMapVoteCandidates(
  db: DatabaseClient,
  serverId: string,
): Promise<MapVoteCandidateEntry[]> {
  return db
    .select({
      layer: mapVoteCandidates.layer,
      map: layers.map,
      weight: mapVoteCandidates.weight,
      enabled: mapVoteCandidates.enabled,
      deprecated: layers.deprecated,
    })
    .from(mapVoteCandidates)
    .innerJoin(layers, eq(layers.name, mapVoteCandidates.layer))
    .where(eq(mapVoteCandidates.serverId, serverId));
}

const MAP_VOTE_RECENT_MATCH_LIMIT = 50;

/** Recent matches (newest first, open match included) for cooldown checks. */
export async function loadRecentMatchesForMapVote(
  db: DatabaseClient,
  serverId: string,
): Promise<Array<{ layer: string; map: string; isSeed: boolean }>> {
  const rows = await db
    .select({ layer: matches.layer, map: matches.map, isSeed: matches.isSeed })
    .from(matches)
    .where(eq(matches.serverId, serverId))
    .orderBy(desc(matches.startedAt))
    .limit(MAP_VOTE_RECENT_MATCH_LIMIT);
  return rows
    .filter((row): row is { layer: string; map: string | null; isSeed: boolean } =>
      Boolean(row.layer),
    )
    .map((row) => ({ layer: row.layer, map: row.map ?? '', isSeed: row.isSeed }));
}

/**
 * Claims the per-match pick row. `ON CONFLICT (match_id) DO NOTHING
 * RETURNING` returns no id when another tick already inserted the row — the
 * caller must then send nothing (GAME-1 idempotency).
 */
export async function insertMapVotePick(
  db: DatabaseClient,
  pick: {
    serverId: string;
    matchId: string;
    layer: string;
    selection: MapVoteServerEntry['selection'];
    candidateSnapshot: MapVoteCandidateEntry[];
    rngSeed: string;
  },
): Promise<string | null> {
  const rows = await db
    .insert(mapVotePicks)
    .values({
      serverId: pick.serverId,
      matchId: pick.matchId,
      layer: pick.layer,
      selection: pick.selection,
      candidateSnapshot: pick.candidateSnapshot,
      rngSeed: pick.rngSeed,
    })
    .onConflictDoNothing({ target: mapVotePicks.matchId })
    .returning({ id: mapVotePicks.id });
  return rows[0]?.id ?? null;
}

export async function markMapVotePickApplied(db: DatabaseClient, pickId: string): Promise<void> {
  await db.update(mapVotePicks).set({ applied: true }).where(eq(mapVotePicks.id, pickId));
}

export async function setMapVotePickFailure(
  db: DatabaseClient,
  pickId: string,
  reason: string,
): Promise<void> {
  await db.update(mapVotePicks).set({ failureReason: reason }).where(eq(mapVotePicks.id, pickId));
}

export async function writeMapVoteAuditEntry(
  db: DatabaseClient,
  entry: MapVoteAuditEntry,
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

export function createMapVoteDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'get' | 'xadd'>,
): Omit<MapVoteTickDeps, 'diag'> {
  return {
    loadEnabledServers: () => loadEnabledMapVoteServers(db),
    getLatestMatch: (serverId) => getLatestMatchForMapVote(db, serverId),
    hasPickForMatch: (matchId) => hasMapVotePickForMatch(db, matchId),
    loadCandidates: (serverId) => loadMapVoteCandidates(db, serverId),
    loadRecentMatches: (serverId) => loadRecentMatchesForMapVote(db, serverId),
    insertPick: (pick) => insertMapVotePick(db, pick),
    markPickApplied: (pickId) => markMapVotePickApplied(db, pickId),
    setPickFailure: (pickId, reason) => setMapVotePickFailure(db, pickId, reason),
    isDepotUpdating: () => isDepotUpdating(redis),
    sendRconCommand: (input, requestId) => sendRconCommand(redis, input, requestId),
    writeAuditEntry: (entry) => writeMapVoteAuditEntry(db, entry),
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
    rotationIndex: row.rotationIndex,
    createdBy: row.createdBy,
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
    advanceRotationIndex: (taskId, nextIndex) =>
      setScheduledTaskRotationIndex(db, taskId, nextIndex),
    echoBroadcastToChat: (echo) => echoScheduledBroadcast(db, echo),
    recordRun: (run) => recordScheduledTaskRun(db, run),
    writeAuditEntry: (entry) => writeScheduledTaskAuditEntry(db, entry),
  };
}

// LEAD-7 (#178) — season finalisation.

/** Mirrors CACHE_PREFIX in apps/api/src/routes/leaderboards.ts. */
const LEADERBOARD_CACHE_PREFIX = 'leaderboard:';

/** Active, not-yet-frozen seasons — the only ones the finalize tick may close. */
export async function loadActiveSeasons(db: DatabaseClient): Promise<ActiveSeason[]> {
  const rows = await db
    .select({
      id: seasons.id,
      name: seasons.name,
      startsAt: seasons.startsAt,
      endsAt: seasons.endsAt,
    })
    .from(seasons)
    .where(and(eq(seasons.status, 'active'), eq(seasons.finalized, false)));
  return rows;
}

/**
 * Closes a season and freezes its materialised slice in one statement, so the
 * two can never drift apart. `loadActiveSeasonTarget` in @squad/db skips
 * finalized rows, which is what stops the aggregator recomputing it.
 */
export async function finalizeSeason(db: DatabaseClient, seasonId: string): Promise<void> {
  await db
    .update(seasons)
    .set({ status: 'closed', finalized: true, updatedAt: new Date() })
    .where(eq(seasons.id, seasonId));
}

export async function invalidateLeaderboardCache(
  redis: Pick<Redis, 'scanStream' | 'del'>,
): Promise<number> {
  const keys: string[] = [];
  const stream = redis.scanStream({ match: `${LEADERBOARD_CACHE_PREFIX}*`, count: 200 });
  for await (const batch of stream) {
    for (const key of batch as string[]) keys.push(key);
  }
  if (keys.length === 0) return 0;
  await redis.del(...keys);
  return keys.length;
}

export async function writeSeasonFinalizeAuditEntry(
  db: DatabaseClient,
  entry: SeasonFinalizeAuditEntry,
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

export function createSeasonFinalizeDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'scanStream' | 'del'>,
): Omit<SeasonFinalizeTickDeps, 'now' | 'diag'> {
  return {
    loadActiveSeasons: () => loadActiveSeasons(db),
    finalizeSeason: (seasonId) => finalizeSeason(db, seasonId),
    invalidateLeaderboardCache: () => invalidateLeaderboardCache(redis),
    writeAuditEntry: (entry) => writeSeasonFinalizeAuditEntry(db, entry),
  };
}
