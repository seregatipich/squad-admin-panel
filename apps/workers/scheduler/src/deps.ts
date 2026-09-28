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
import {
  PermanentTaskDispatchError,
  type ScheduledBroadcastEcho,
  type ScheduledTaskAuditEntry,
  type ScheduledTaskEntry,
  type ScheduledTaskRunRecord,
  type ScheduledTaskTickDeps,
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
    .where(and(eq(seedSchedule.enabled, true), isNull(servers.deletedAt)));
  return rows;
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

/** Loads enabled one-off rotation changes for the scheduler tick, excluding soft-deleted servers. */
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
    .where(and(eq(rotationSchedule.enabled, true), isNull(servers.deletedAt)));
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
    // Profiles are applied by rewriting LayerRotation.cfg through the bridge,
    // which only exists for panel-hosted (container) servers.
    .where(and(isNull(servers.deletedAt), eq(servers.runtime, 'container')));
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

/** Loads enabled general scheduled tasks (AUTO-2, #73) for the scheduler tick, excluding soft-deleted servers. */
export async function loadEnabledScheduledTasks(db: DatabaseClient): Promise<ScheduledTaskEntry[]> {
  const rows = await db
    .select({
      id: scheduledTasks.id,
      serverId: scheduledTasks.serverId,
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
 * bridge the scheduler already holds. `containerStop` errors are swallowed
 * the same way the API route swallows them (Docker's `start` on an already-
 * running or already-stopped container is itself a no-op success), so this
 * mirrors that route's container-level behavior.
 *
 * It does NOT reproduce the rest of that route: it does not flip
 * `servers.status` to `'starting'` in the DB, publish to `liveBus` (the
 * scheduler worker has no websocket fan-out), or call `relaunchSidecar`
 * (API-only `apps/api/src/lib` logic worker packages do not import — see
 * `docs/development/conventions.md`). A scheduled restart is therefore
 * visible to the UI only once the status reconciler's next pass catches up,
 * and a sidecar stopped manually before the scheduled restart stays down.
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
    },
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
