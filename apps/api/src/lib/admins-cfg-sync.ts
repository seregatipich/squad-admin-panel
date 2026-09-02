import type { DatabaseClient } from '@squad/db';
import { adminsCfgSyncOutbox, servers } from '@squad/db/schema';
import { inArray, isNull } from 'drizzle-orm';
import type Redis from 'ioredis';

export const ADMINS_CFG_SYNC_STREAM_PREFIX = 'events:admins-cfg-sync:';
export const ADMINS_CFG_SYNC_GROUP = 'config-sync';

// A db handle that can either be the top-level client or a transaction
// passed into a `db.transaction(async tx => ...)` callback. Drizzle's
// transaction value isn't structurally compatible with DatabaseClient
// (no `$client`), but it has the same select/insert/update surface used
// here. Using the structural type lets the enqueue helper run inside the
// same transaction as the DB mutation per spec §2.7.1 / SYNC-1.
export type AdminsCfgSyncDb = Pick<DatabaseClient, 'select' | 'insert' | 'update'>;

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
 * As a latency optimisation it then attempts an immediate best-effort `XADD`
 * and stamps `relayed_at` on the rows that publish successfully. This publish
 * is deliberately non-fatal: a transient Redis outage must not roll back the
 * mutation, because the worker's outbox relay ({@link relayAdminsCfgSyncOutbox})
 * will deliver any still-pending row at-least-once. Idempotency remains the
 * worker's job — it diff-compares hashes before writing the file, so an
 * at-least-once redelivery is a no-op.
 */
export async function publishAdminsCfgSyncForAllServers(
  db: AdminsCfgSyncDb,
  redis: Redis,
  event: AdminsCfgSyncEvent,
  serverIds?: readonly string[],
): Promise<{ enqueued: number }> {
  const activeServers = serverIds
    ? serverIds.map((id) => ({ id }))
    : await db.select({ id: servers.id }).from(servers).where(isNull(servers.deletedAt));
  if (activeServers.length === 0) return { enqueued: 0 };

  const inserted = await db
    .insert(adminsCfgSyncOutbox)
    .values(activeServers.map((s) => ({ serverId: s.id, payload: event })))
    .returning({ id: adminsCfgSyncOutbox.id, serverId: adminsCfgSyncOutbox.serverId });

  const relayedIds = await tryImmediateDispatch(redis, inserted, event);
  if (relayedIds.length > 0) {
    await db
      .update(adminsCfgSyncOutbox)
      .set({ relayedAt: new Date() })
      .where(inArray(adminsCfgSyncOutbox.id, relayedIds));
  }

  return { enqueued: inserted.length };
}

/**
 * Best-effort immediate publish of freshly-inserted outbox rows. Returns the
 * ids that were published so the caller can stamp them relayed in the same
 * transaction. Any failure (Redis down, pipeline error) yields an empty list —
 * the rows stay pending for the relay rather than blocking the mutation.
 */
async function tryImmediateDispatch(
  redis: Redis,
  rows: Array<{ id: string; serverId: string }>,
  event: AdminsCfgSyncEvent,
): Promise<string[]> {
  const payload = JSON.stringify(event);
  try {
    const pipeline = redis.pipeline();
    for (const row of rows) {
      pipeline.xadd(
        `${ADMINS_CFG_SYNC_STREAM_PREFIX}${row.serverId}`,
        'MAXLEN',
        '~',
        '500',
        '*',
        'event',
        payload,
      );
    }
    const results = await pipeline.exec();
    if (!results) return [];
    const relayed: string[] = [];
    results.forEach(([err], i) => {
      const row = rows[i];
      if (!err && row) relayed.push(row.id);
    });
    return relayed;
  } catch {
    return [];
  }
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
