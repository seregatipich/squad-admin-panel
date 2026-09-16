import {
  type AdminsCfgAppliedOutcome,
  type AdminsCfgFailureCode,
  getAdminsCfgSyncOutboxState,
  markAdminsCfgSyncApplied,
  markAdminsCfgSyncFailed,
  servers,
} from '@squad/db';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { validate as isUuid } from 'uuid';
import { confirmAdminsCfgReload } from './rcon-reload.js';
import { type AdminsCfgServerLease, type SyncContext, withAdminsCfgSyncLease } from './syncer.js';

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
  getOutbox(db: AdminsCfgServerLease['db'], id: string): Promise<OutboxState>;
  markApplied(
    db: AdminsCfgServerLease['db'],
    id: string,
    outcome: AdminsCfgAppliedOutcome,
  ): ReturnType<typeof markAdminsCfgSyncApplied>;
  markFailed(
    db: AdminsCfgServerLease['db'],
    id: string,
    code: AdminsCfgFailureCode,
  ): ReturnType<typeof markAdminsCfgSyncFailed>;
  readServerState(db: AdminsCfgServerLease['db'], serverId: string): Promise<ServerState>;
  withServerLock<T>(
    ctx: SyncContext,
    serverId: string,
    work: (lease: AdminsCfgServerLease) => Promise<T>,
  ): Promise<T>;
  confirmReload: typeof confirmAdminsCfgReload;
}

const defaultOperations: AdminsCfgDeliveryOperations = {
  getOutbox: getAdminsCfgSyncOutboxState,
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
  withServerLock: withAdminsCfgSyncLease,
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
  db: AdminsCfgServerLease['db'],
  operations: AdminsCfgDeliveryOperations,
  outboxId: string,
  outcome: AdminsCfgAppliedOutcome,
): Promise<'completed'> {
  await operations.markApplied(db, outboxId, outcome);
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
    const outcome = await operations.withServerLock(ctx, entry.serverId, (lease) =>
      lease.sync(syncParameters(event)),
    );
    if (outcome.state === 'unreachable') return 'retry';
    await acknowledgeAndDeleteAdminsCfgEntry(ctx.redis, entry.streamName, entry.streamId);
    return 'completed';
  }

  if (typeof outboxId !== 'string' || !isUuid(outboxId)) {
    ctx.log.warn({ serverId: entry.serverId, streamId: entry.streamId }, 'invalid outbox id');
    await acknowledgeAndDeleteAdminsCfgEntry(ctx.redis, entry.streamName, entry.streamId);
    return 'completed';
  }

  const outcome = await operations.withServerLock(ctx, entry.serverId, async (lease) => {
    // This is intentionally the first durable read: it must happen only after
    // the per-server fence is held, including for fresh, reclaimed and replayed
    // entries.
    const outbox = await operations.getOutbox(lease.db, outboxId);
    if (!outbox || outbox.serverId !== entry.serverId) {
      ctx.log.warn({ serverId: entry.serverId, streamId: entry.streamId }, 'invalid outbox link');
      return 'completed' as const;
    }
    if (outbox.appliedAt !== null) {
      return 'completed' as const;
    }

    const syncResult = await lease.sync({
      ...syncParameters(outbox.payload),
      mode: 'active',
      requestReload: false,
    });
    if (syncResult.state === 'unreachable') {
      await operations.markFailed(lease.db, outboxId, 'unavailable');
      return 'retry' as const;
    }

    const firstState = await operations.readServerState(lease.db, entry.serverId);
    if (isRemoved(firstState)) {
      return complete(lease.db, operations, outboxId, 'server_removed');
    }

    let reloadConfirmed = false;
    if (isLive(firstState)) {
      const reload = await operations.confirmReload(ctx.redis, entry.serverId, outboxId, ctx.log);
      if (reload !== 'confirmed') {
        await operations.markFailed(lease.db, outboxId, reload);
        return 'retry' as const;
      }
      reloadConfirmed = true;
    }

    let finalState = await operations.readServerState(lease.db, entry.serverId);
    if (isRemoved(finalState)) {
      return complete(lease.db, operations, outboxId, 'server_removed');
    }

    if (isLive(finalState) && !reloadConfirmed) {
      const reload = await operations.confirmReload(ctx.redis, entry.serverId, outboxId, ctx.log);
      if (reload !== 'confirmed') {
        await operations.markFailed(lease.db, outboxId, reload);
        return 'retry' as const;
      }
      finalState = await operations.readServerState(lease.db, entry.serverId);
      if (isRemoved(finalState)) {
        return complete(lease.db, operations, outboxId, 'server_removed');
      }
    }

    return complete(
      lease.db,
      operations,
      outboxId,
      isLive(finalState) ? 'confirmed' : 'file_ready_for_restart',
    );
  });

  if (outcome === 'completed') {
    // The database transaction releases its advisory lock before Redis ACK;
    // a crash in this gap replays only the already-durable terminal row.
    await acknowledgeAndDeleteAdminsCfgEntry(ctx.redis, entry.streamName, entry.streamId);
  }
  return outcome;
}
