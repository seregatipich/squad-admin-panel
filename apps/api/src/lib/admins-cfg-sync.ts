import type { DatabaseClient } from '@squad/db';
import { servers } from '@squad/db/schema';
import { isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';

export const ADMINS_CFG_SYNC_STREAM_PREFIX = 'events:admins-cfg-sync:';
export const ADMINS_CFG_SYNC_GROUP = 'config-sync';

// A db handle that can either be the top-level client or a transaction
// passed into a `db.transaction(async tx => ...)` callback. Drizzle's
// transaction value isn't structurally compatible with DatabaseClient
// (no `$client`), but it has the same select/from/where surface used
// here. Using the structural type lets the publish helper run inside
// the same transaction as the DB mutation per spec §2.7.1.
export type AdminsCfgSyncDb = Pick<DatabaseClient, 'select'>;

export interface AdminsCfgSyncEvent {
  reason: string;
  actor_steam_id64: string | null;
  enqueued_at: string;
  request_id?: string;
}

/**
 * Publish a sync task to every active server's `events:admins-cfg-sync:*`
 * stream. The worker `config-sync` consumes these in a consumer group.
 *
 * Always-fire on every relevant DB mutation: role changes, player role
 * changes, server install. Idempotency is the worker's job — it diff-
 * compares hashes before writing to the file.
 */
export async function publishAdminsCfgSyncForAllServers(
  db: AdminsCfgSyncDb,
  redis: Redis,
  event: AdminsCfgSyncEvent,
): Promise<{ enqueued: number }> {
  const rows = await db.select({ id: servers.id }).from(servers).where(isNull(servers.deletedAt));
  if (rows.length === 0) return { enqueued: 0 };
  const payload = JSON.stringify(event);
  const pipeline = redis.pipeline();
  for (const row of rows) {
    pipeline.xadd(
      `${ADMINS_CFG_SYNC_STREAM_PREFIX}${row.id}`,
      'MAXLEN',
      '~',
      '500',
      '*',
      'event',
      payload,
    );
  }
  await pipeline.exec();
  return { enqueued: rows.length };
}

/**
 * Publish a sync task for a single server (used by the install flow and the
 * /admins-cfg/sync force endpoint).
 */
export async function publishAdminsCfgSyncForServer(
  redis: Redis,
  serverId: string,
  event: AdminsCfgSyncEvent,
): Promise<void> {
  await redis.xadd(
    `${ADMINS_CFG_SYNC_STREAM_PREFIX}${serverId}`,
    'MAXLEN',
    '~',
    '500',
    '*',
    'event',
    JSON.stringify(event),
  );
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
      '$',
      'MKSTREAM',
    );
  } catch (err) {
    if ((err as Error).message?.includes('BUSYGROUP')) return;
    throw err;
  }
}

void sql; // keep import for downstream reuse
