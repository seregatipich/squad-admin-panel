import { asc, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from './client.js';
import { adminsCfgSyncOutbox } from './schema/admins-cfg-sync-outbox.js';
import { servers } from './schema/servers.js';

/**
 * Minimal structural view of the Redis client the relay needs. Declared here
 * so `@squad/db` does not have to depend on `ioredis`; callers pass their real
 * ioredis instance, which satisfies this shape.
 */
export interface OutboxRelayRedis {
  xadd(key: string, ...args: (string | number)[]): Promise<string | null>;
}

export interface RelayAdminsCfgSyncOutboxOptions {
  /** Stream key prefix, e.g. `events:admins-cfg-sync:` (server id is appended). */
  streamPrefix: string;
  /** Approximate stream cap passed as `MAXLEN ~ <maxlen>`. Defaults to 500. */
  maxlen?: number;
  /** Rows claimed per transaction. Defaults to 200. */
  batchSize?: number;
}

export interface RelayAdminsCfgSyncOutboxResult {
  relayed: number;
}

type RelayDb = Pick<DatabaseClient, 'transaction'>;

/**
 * Drain pending Admins.cfg outbox rows onto their per-server Redis stream.
 *
 * Each batch is claimed with `FOR UPDATE SKIP LOCKED` inside a transaction,
 * published with `XADD`, and stamped `relayed_at` before the transaction
 * commits. Delivery is **at-least-once**: if the process dies after the `XADD`
 * but before commit, the rows stay pending and are re-published on the next
 * run — a duplicate stream entry that the worker's idempotent hash-compare
 * collapses to a no-op. A re-run over already-relayed rows publishes nothing
 * (they no longer match `relayed_at IS NULL`), so effects are never duplicated
 * by the relay itself.
 *
 * Rows whose server has been **soft-deleted** (`servers.deleted_at IS NOT
 * NULL`) are never published — an `XADD` would recreate the very stream the
 * delete tore down (SYNC-5). They are instead stamped `relayed_at` without a
 * publish so the pending queue drains and the relay never loops on them. The
 * server join uses `FOR UPDATE OF admins_cfg_sync_outbox` so only the outbox
 * rows are locked, never the `servers` rows.
 *
 * @returns the number of rows published to a stream across all batches
 *   (soft-deleted rows that were cancelled without publishing are not counted).
 */
export async function relayAdminsCfgSyncOutbox(
  db: RelayDb,
  redis: OutboxRelayRedis,
  opts: RelayAdminsCfgSyncOutboxOptions,
): Promise<RelayAdminsCfgSyncOutboxResult> {
  const maxlen = opts.maxlen ?? 500;
  const batchSize = opts.batchSize ?? 200;
  let relayed = 0;

  for (;;) {
    const drained = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: adminsCfgSyncOutbox.id,
          serverId: adminsCfgSyncOutbox.serverId,
          payload: adminsCfgSyncOutbox.payload,
          serverDeletedAt: servers.deletedAt,
        })
        .from(adminsCfgSyncOutbox)
        .innerJoin(servers, eq(servers.id, adminsCfgSyncOutbox.serverId))
        .where(isNull(adminsCfgSyncOutbox.relayedAt))
        .orderBy(asc(adminsCfgSyncOutbox.createdAt))
        .limit(batchSize)
        .for('update', { of: adminsCfgSyncOutbox, skipLocked: true });

      if (rows.length === 0) return true;

      for (const row of rows) {
        if (row.serverDeletedAt !== null) {
          // Server soft-deleted: drain the row without publishing so the
          // torn-down stream is never resurrected (SYNC-5).
          await tx
            .update(adminsCfgSyncOutbox)
            .set({ relayedAt: new Date() })
            .where(eq(adminsCfgSyncOutbox.id, row.id));
          continue;
        }
        const streamId = await redis.xadd(
          `${opts.streamPrefix}${row.serverId}`,
          'MAXLEN',
          '~',
          String(maxlen),
          '*',
          'event',
          JSON.stringify(row.payload),
        );
        await tx
          .update(adminsCfgSyncOutbox)
          .set({ relayedAt: new Date(), streamId: streamId ?? null })
          .where(eq(adminsCfgSyncOutbox.id, row.id));
        relayed += 1;
      }

      // Fewer rows than the batch size means the pending queue is drained.
      return rows.length < batchSize;
    });

    if (drained) break;
  }

  return { relayed };
}
