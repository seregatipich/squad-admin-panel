import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from './client.js';
import { adminsCfgSyncOutbox } from './schema/admins-cfg-sync-outbox.js';
import { servers } from './schema/servers.js';

type EnqueueDb = Pick<DatabaseClient, 'select' | 'insert'>;

const APPLIED_OUTCOMES = ['confirmed', 'file_ready_for_restart', 'server_removed'] as const;
const FAILURE_CODES = ['unavailable', 'rejected', 'timeout', 'invalid_result'] as const;

export type AdminsCfgAppliedOutcome = (typeof APPLIED_OUTCOMES)[number];
export type AdminsCfgFailureCode = (typeof FAILURE_CODES)[number];

type ApplicationDb = Pick<DatabaseClient, 'select' | 'update'>;

/** Read the durable state used to make a redelivery idempotent. */
export async function getAdminsCfgSyncOutboxState(db: ApplicationDb, id: string) {
  const [row] = await db
    .select()
    .from(adminsCfgSyncOutbox)
    .where(eq(adminsCfgSyncOutbox.id, id))
    .limit(1);
  return row ?? null;
}

/** Persist a successful terminal result once; concurrent replays return the winner. */
export async function markAdminsCfgSyncApplied(db: ApplicationDb, id: string, outcome: string) {
  if (!(APPLIED_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error('invalid admins cfg sync applied outcome');
  }
  const [updated] = await db
    .update(adminsCfgSyncOutbox)
    .set({
      appliedAt: new Date(),
      reloadOutcome: outcome,
      lastError: null,
    })
    .where(and(eq(adminsCfgSyncOutbox.id, id), isNull(adminsCfgSyncOutbox.appliedAt)))
    .returning();
  return updated ?? getAdminsCfgSyncOutboxState(db, id);
}

/** Persist a safe retryable failure code without exposing raw bridge/RCON errors. */
export async function markAdminsCfgSyncFailed(db: ApplicationDb, id: string, code: string) {
  if (!(FAILURE_CODES as readonly string[]).includes(code)) {
    throw new Error('invalid admins cfg sync failure code');
  }
  const [updated] = await db
    .update(adminsCfgSyncOutbox)
    .set({ reloadOutcome: code, lastError: code })
    .where(and(eq(adminsCfgSyncOutbox.id, id), isNull(adminsCfgSyncOutbox.appliedAt)))
    .returning();
  return updated ?? getAdminsCfgSyncOutboxState(db, id);
}

/** Insert one durable task per active server, or per explicit server snapshot. */
export async function enqueueAdminsCfgSyncForAllServers(
  db: EnqueueDb,
  payload: unknown,
  serverIds?: readonly string[],
  correlationId?: string,
): Promise<{ enqueued: number }> {
  const targets = serverIds
    ? serverIds.map((id) => ({ id }))
    : await db.select({ id: servers.id }).from(servers).where(isNull(servers.deletedAt));
  if (targets.length === 0) return { enqueued: 0 };

  const inserted = await db
    .insert(adminsCfgSyncOutbox)
    .values(targets.map(({ id }) => ({ serverId: id, payload, correlationId })))
    .returning({ id: adminsCfgSyncOutbox.id });
  return { enqueued: inserted.length };
}

/** Insert one durable task for an already validated server. */
export async function enqueueAdminsCfgSyncForServer(
  db: Pick<DatabaseClient, 'insert'>,
  serverId: string,
  payload: unknown,
  correlationId?: string,
): Promise<void> {
  await db.insert(adminsCfgSyncOutbox).values({ serverId, payload, correlationId });
}

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
  /** Rows claimed per transaction. Defaults to 200. */
  batchSize?: number;
  /** Maximum wait for one Redis XADD before rolling the DB transaction back. */
  xaddTimeoutMs?: number;
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
 * run — a duplicate stream entry with the same `_outbox_id`. The worker either
 * completes that durable row or, if already applied, only ACKs/deletes the
 * duplicate without touching the file or RCON. A re-run over already-relayed rows publishes nothing
 * (they no longer match `relayed_at IS NULL`), so effects are never duplicated
 * by the relay itself.
 *
 * Rows whose server has been **soft-deleted** (`servers.deleted_at IS NOT
 * NULL`) are never published — an `XADD` would recreate the very stream the
 * delete tore down (SYNC-5). They are terminally completed with `applied_at`
 * and `reload_outcome=server_removed`, and stamped `relayed_at` without a
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
  const batchSize = opts.batchSize ?? 200;
  const xaddTimeoutMs = opts.xaddTimeoutMs ?? 5_000;
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
            .set({
              relayedAt: new Date(),
              appliedAt: new Date(),
              reloadOutcome: 'server_removed',
              lastError: null,
            })
            .where(eq(adminsCfgSyncOutbox.id, row.id));
          continue;
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const streamId = await Promise.race([
          redis.xadd(
            `${opts.streamPrefix}${row.serverId}`,
            '*',
            'event',
            JSON.stringify({
              ...(row.payload as Record<string, unknown>),
              _outbox_id: row.id,
            }),
          ),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('admins_cfg_outbox_xadd_timeout')),
              xaddTimeoutMs,
            );
          }),
        ]).finally(() => {
          if (timeout) clearTimeout(timeout);
        });
        if (!streamId) throw new Error('admins_cfg_outbox_xadd_missing_stream_id');
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
