import {
  type AdminsCfgAppliedOutcome,
  type AdminsCfgFailureCode,
  type DatabaseClient,
  getAdminsCfgSyncOutboxState,
  markAdminsCfgSyncApplied,
  markAdminsCfgSyncFailed,
  servers,
  vipLifecycleEvents,
} from '@squad/db';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { validate as isUuid } from 'uuid';
import { confirmAdminsCfgReload } from './rcon-reload.js';
import { type SyncContext, syncServerAdminsCfg } from './syncer.js';

export const ADMINS_CFG_SYNC_GROUP = 'config-sync';

const ACK_AND_DELETE_SCRIPT = `
local acked = redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
local deleted = redis.call('XDEL', KEYS[1], ARGV[2])
return {acked, deleted}
`;

export interface AdminsCfgSyncEvent {
  reason?: string;
  actor_player_id?: string | null;
  enqueued_at?: string;
  request_id?: string;
  forceWrite?: boolean;
  _outbox_id?: unknown;
}

export interface AdminsCfgStreamEntry {
  serverId: string;
  streamName: string;
  streamId: string;
  event: unknown;
}

type OutboxState = Awaited<ReturnType<typeof getAdminsCfgSyncOutboxState>>;
type ServerState = { status: string; deletedAt: Date | null } | null;

export interface AdminsCfgDeliveryOperations {
  getOutbox(db: DatabaseClient, id: string): Promise<OutboxState>;
  isSuperseded(db: DatabaseClient, row: NonNullable<OutboxState>): Promise<boolean>;
  markApplied(
    db: DatabaseClient,
    id: string,
    outcome: AdminsCfgAppliedOutcome,
  ): ReturnType<typeof markAdminsCfgSyncApplied>;
  markFailed(
    db: DatabaseClient,
    id: string,
    code: AdminsCfgFailureCode,
  ): ReturnType<typeof markAdminsCfgSyncFailed>;
  readServerState(db: DatabaseClient, serverId: string): Promise<ServerState>;
  sync: typeof syncServerAdminsCfg;
  confirmReload: typeof confirmAdminsCfgReload;
}

const defaultOperations: AdminsCfgDeliveryOperations = {
  getOutbox: getAdminsCfgSyncOutboxState,
  async isSuperseded(db, row) {
    if (!row.correlationId) return false;
    const [event] = await db
      .select({
        action: vipLifecycleEvents.action,
        supersededByEventId: vipLifecycleEvents.supersededByEventId,
      })
      .from(vipLifecycleEvents)
      .where(eq(vipLifecycleEvents.eventId, row.correlationId))
      .limit(1);
    return event ? event.action === 'superseded' || event.supersededByEventId !== null : false;
  },
  markApplied: markAdminsCfgSyncApplied,
  markFailed: markAdminsCfgSyncFailed,
  async readServerState(db, serverId) {
    const [server] = await db
      .select({ status: servers.status, deletedAt: servers.deletedAt })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    return server ?? null;
  },
  sync: syncServerAdminsCfg,
  confirmReload: confirmAdminsCfgReload,
};

function isLive(state: ServerState): boolean {
  return (
    state !== null && state.deletedAt === null && ['running', 'starting'].includes(state.status)
  );
}

function isRemoved(state: ServerState): boolean {
  return state === null || state.deletedAt !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function syncParameters(payload: unknown) {
  const event = isPlainObject(payload) ? payload : {};
  const reason = typeof event.reason === 'string' ? event.reason : 'unknown';
  return {
    reason,
    actorPlayerId: typeof event.actor_player_id === 'string' ? event.actor_player_id : null,
    forceWrite: reason === 'force_sync' || event.forceWrite === true,
  };
}

export async function acknowledgeAndDeleteAdminsCfgEntry(
  redis: Redis,
  streamName: string,
  streamId: string,
): Promise<void> {
  // One Redis script removes the crash gap while preserving the required
  // command order: durable DB result first, then XACK, then exact XDEL.
  await redis.eval(ACK_AND_DELETE_SCRIPT, 1, streamName, ADMINS_CFG_SYNC_GROUP, streamId);
}

async function complete(
  ctx: SyncContext,
  entry: AdminsCfgStreamEntry,
  operations: AdminsCfgDeliveryOperations,
  outboxId: string,
  outcome: AdminsCfgAppliedOutcome,
): Promise<'completed'> {
  await operations.markApplied(ctx.db, outboxId, outcome);
  await acknowledgeAndDeleteAdminsCfgEntry(ctx.redis, entry.streamName, entry.streamId);
  return 'completed';
}

/** Apply one fresh or reclaimed Admins.cfg stream entry. */
export async function handleAdminsCfgSyncEntry(
  ctx: SyncContext,
  entry: AdminsCfgStreamEntry,
  operations: AdminsCfgDeliveryOperations = defaultOperations,
): Promise<'completed' | 'retry'> {
  const { event } = entry;
  if (!isPlainObject(event)) {
    ctx.log.warn({ serverId: entry.serverId, streamId: entry.streamId }, 'invalid sync event');
    await acknowledgeAndDeleteAdminsCfgEntry(ctx.redis, entry.streamName, entry.streamId);
    return 'completed';
  }
  const hasOutboxId = Object.hasOwn(event, '_outbox_id');
  const outboxId = event._outbox_id;

  if (!hasOutboxId) {
    const result = await operations.sync(ctx, entry.serverId, syncParameters(event));
    if (result.state === 'unreachable') return 'retry';
    await acknowledgeAndDeleteAdminsCfgEntry(ctx.redis, entry.streamName, entry.streamId);
    return 'completed';
  }

  if (typeof outboxId !== 'string' || !isUuid(outboxId)) {
    ctx.log.warn({ serverId: entry.serverId, streamId: entry.streamId }, 'invalid outbox id');
    await acknowledgeAndDeleteAdminsCfgEntry(ctx.redis, entry.streamName, entry.streamId);
    return 'completed';
  }

  const outbox = await operations.getOutbox(ctx.db, outboxId);
  if (!outbox || outbox.serverId !== entry.serverId) {
    ctx.log.warn({ serverId: entry.serverId, streamId: entry.streamId }, 'invalid outbox link');
    await acknowledgeAndDeleteAdminsCfgEntry(ctx.redis, entry.streamName, entry.streamId);
    return 'completed';
  }
  if (outbox.appliedAt !== null || (await operations.isSuperseded(ctx.db, outbox))) {
    await acknowledgeAndDeleteAdminsCfgEntry(ctx.redis, entry.streamName, entry.streamId);
    return 'completed';
  }

  const syncResult = await operations.sync(ctx, entry.serverId, {
    ...syncParameters(outbox.payload),
    mode: 'active',
    requestReload: false,
  });
  if (syncResult.state === 'unreachable') {
    await operations.markFailed(ctx.db, outboxId, 'unavailable');
    return 'retry';
  }

  const firstState = await operations.readServerState(ctx.db, entry.serverId);
  if (isRemoved(firstState)) return complete(ctx, entry, operations, outboxId, 'server_removed');

  let reloadConfirmed = false;
  if (isLive(firstState)) {
    const reload = await operations.confirmReload(ctx.redis, entry.serverId, outboxId, ctx.log);
    if (reload !== 'confirmed') {
      await operations.markFailed(ctx.db, outboxId, reload);
      return 'retry';
    }
    reloadConfirmed = true;
  }

  let finalState = await operations.readServerState(ctx.db, entry.serverId);
  if (isRemoved(finalState)) return complete(ctx, entry, operations, outboxId, 'server_removed');

  if (isLive(finalState) && !reloadConfirmed) {
    const reload = await operations.confirmReload(ctx.redis, entry.serverId, outboxId, ctx.log);
    if (reload !== 'confirmed') {
      await operations.markFailed(ctx.db, outboxId, reload);
      return 'retry';
    }
    finalState = await operations.readServerState(ctx.db, entry.serverId);
    if (isRemoved(finalState)) return complete(ctx, entry, operations, outboxId, 'server_removed');
  }

  return complete(
    ctx,
    entry,
    operations,
    outboxId,
    isLive(finalState) ? 'confirmed' : 'file_ready_for_restart',
  );
}
