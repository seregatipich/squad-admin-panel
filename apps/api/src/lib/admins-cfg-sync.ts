import {
  type DatabaseClient,
  enqueueAdminsCfgSyncForAllServers,
  enqueueAdminsCfgSyncForServer,
} from '@squad/db';
import type Redis from 'ioredis';

export const ADMINS_CFG_SYNC_STREAM_PREFIX = 'events:admins-cfg-sync:';
export const ADMINS_CFG_SYNC_GROUP = 'config-sync';

// A db handle that can either be the top-level client or a transaction
// passed into a `db.transaction(async tx => ...)` callback. Drizzle's
// transaction value isn't structurally compatible with DatabaseClient
// (no `$client`), but it has the same select/insert surface used
// here. Using the structural type lets the enqueue helper run inside the
// same transaction as the DB mutation per spec §2.7.1 / SYNC-1.
export type AdminsCfgSyncDb = Pick<DatabaseClient, 'select' | 'insert'>;

export interface AdminsCfgSyncEvent {
  reason: string;
  actor_player_id: string | null;
  enqueued_at: string;
  request_id?: string;
}

/**
 * Enqueue a sync task for every active server via the durable transactional
 * outbox (SYNC-1, #34).
 *
 * Called inside the same transaction as the domain mutation, this inserts one
 * pending `admins_cfg_sync_outbox` row per active server. The insert commits or
 * rolls back atomically with the mutation, so a committed mutation can never
 * exist without a corresponding sync task — the durability guarantee a
 * Redis-only queue cannot make (a trimmed or lost stream entry would strand the
 * mutation until a manual force-sync).
 * Lifecycle callers pass the non-empty server-id snapshot they just validated;
 * other callers keep the ordinary active-server lookup here.
 *
 * Redis is deliberately absent here: only the relay can publish committed
 * rows. This keeps rollback from leaking an external stream entry.
 */
export async function publishAdminsCfgSyncForAllServers(
  db: AdminsCfgSyncDb,
  event: AdminsCfgSyncEvent,
  serverIds?: readonly string[],
  correlationId?: string,
): Promise<{ enqueued: number }> {
  return enqueueAdminsCfgSyncForAllServers(db, event, serverIds, correlationId);
}

/**
 * Enqueue a sync task for a single server (used by the install flow and the
 * /admins-cfg/sync force endpoint).
 */
export async function publishAdminsCfgSyncForServer(
  db: Pick<DatabaseClient, 'insert'>,
  serverId: string,
  event: AdminsCfgSyncEvent,
): Promise<void> {
  await enqueueAdminsCfgSyncForServer(db, serverId, event);
}

/**
 * Used by the worker on startup to make sure every active server's stream
 * has the consumer group registered. Called from the worker, but kept here
 * so the API can also pre-register the group when a brand-new server is
 * created (avoids the very first XREADGROUP call having to MKSTREAM).
 */
export async function ensureAdminsCfgSyncGroup(redis: Redis, serverId: string): Promise<void> {
  try {
    await redis.xgroup(
      'CREATE',
      `${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`,
      ADMINS_CFG_SYNC_GROUP,
      '0',
      'MKSTREAM',
    );
  } catch (err) {
    if ((err as Error).message?.includes('BUSYGROUP')) return;
    throw err;
  }
}
