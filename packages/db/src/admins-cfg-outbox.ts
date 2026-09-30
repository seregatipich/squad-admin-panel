import { and, asc, eq, isNull, notInArray } from 'drizzle-orm';
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

/**
 * Insert one durable task per active panel-hosted server, or per explicit
 * server snapshot. External servers (`runtime='external'`) are skipped: their
 * `Admins.cfg` is not under the panel's config tree, so there is nothing the
 * config-sync worker could write.
 *
 * @param payload - The sync event; must be a JSON object (its fields are
 *   spread into the stream entry next to `_outbox_id`). The relay refuses a row
 *   whose payload is not an object.
 */
export async function enqueueAdminsCfgSyncForAllServers(
  db: EnqueueDb,
  payload: object,
  serverIds?: readonly string[],
  correlationId?: string,
): Promise<{ enqueued: number }> {
  const targets = serverIds
    ? serverIds.map((id) => ({ id }))
    : await db
        .select({ id: servers.id })
        .from(servers)
        .where(and(isNull(servers.deletedAt), eq(servers.runtime, 'container')));
  if (targets.length === 0) return { enqueued: 0 };

  const inserted = await db
    .insert(adminsCfgSyncOutbox)
    .values(targets.map(({ id }) => ({ serverId: id, payload, correlationId })))
    .returning({ id: adminsCfgSyncOutbox.id });
  return { enqueued: inserted.length };
}

/**
 * Insert one durable task for an already validated server.
 *
 * @param payload - The sync event; a JSON object, as for
 *   {@link enqueueAdminsCfgSyncForAllServers}.
 */
export async function enqueueAdminsCfgSyncForServer(
  db: Pick<DatabaseClient, 'insert'>,
  serverId: string,
  payload: object,
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
  /** Maximum wait for one Redis XADD before that row's transaction rolls back. */
  xaddTimeoutMs?: number;
  /**
   * Failed rows in a row after which the run stops early (Redis is most likely
   * down, so waiting out every remaining row would only add timeouts).
   * Defaults to 3.
   */
  maxConsecutiveFailures?: number;
}

export interface RelayAdminsCfgSyncOutboxResult {
  relayed: number;
}

type RelayDb = Pick<DatabaseClient, 'transaction'>;

type RelayStep =
  | { kind: 'drained' }
  | { kind: 'relayed' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; id: string; error: Error };

/**
 * Drain pending Admins.cfg outbox rows onto their per-server Redis stream.
 *
 * Rows are relayed oldest first, **one row per transaction**: the row is
 * claimed with `FOR UPDATE SKIP LOCKED`, published with `XADD` and stamped
 * `relayed_at`, and that transaction commits before the next row is claimed.
 * A transaction therefore holds at most one row lock for at most one bounded
 * `XADD`, and a failure never rolls back rows that were already published.
 *
 * A row whose publish fails (Redis error, timeout, missing stream id, or a
 * payload that is not a JSON object) stays pending and is skipped for the rest
 * of the run, so one poisoned server stream cannot block the queue for every
 * other server. After `maxConsecutiveFailures` failures in a row the run stops
 * early. When any row failed, the run rejects with the first failure once the
 * other rows are done; the failed rows are retried by the next run.
 *
 * Delivery is **at-least-once**: if the process dies after the `XADD` but
 * before commit — or a timed-out `XADD` still lands later — the row stays
 * pending and is re-published on the next run, a duplicate stream entry with
 * the same `_outbox_id`. The worker either completes that durable row or, if
 * already applied, only ACKs/deletes the duplicate without touching the file
 * or RCON. Already-relayed rows no longer match `relayed_at IS NULL`, so the
 * relay itself never re-publishes them.
 *
 * Rows whose server has been **soft-deleted** (`servers.deleted_at IS NOT
 * NULL`) are never published — an `XADD` would recreate the very stream the
 * delete tore down (SYNC-5). They are terminally completed with `applied_at`
 * and `reload_outcome=server_removed`, and stamped `relayed_at` without a
 * publish so the pending queue drains and the relay never loops on them. The
 * server join uses `FOR UPDATE OF admins_cfg_sync_outbox` so only the outbox
 * rows are locked, never the `servers` rows.
 *
 * @returns the number of rows published to a stream (soft-deleted rows that
 *   were cancelled without publishing are not counted).
 * @throws The first publish failure of the run, after every other claimable
 *   row was relayed; database errors propagate immediately.
 */
export async function relayAdminsCfgSyncOutbox(
  db: RelayDb,
  redis: OutboxRelayRedis,
  opts: RelayAdminsCfgSyncOutboxOptions,
): Promise<RelayAdminsCfgSyncOutboxResult> {
  const xaddTimeoutMs = opts.xaddTimeoutMs ?? 5_000;
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 3;
  const failedIds: string[] = [];
  let firstFailure: Error | null = null;
  let consecutiveFailures = 0;
  let relayed = 0;

  while (consecutiveFailures < maxConsecutiveFailures) {
    const step = await db.transaction(async (tx): Promise<RelayStep> => {
      const [row] = await tx
        .select({
          id: adminsCfgSyncOutbox.id,
          serverId: adminsCfgSyncOutbox.serverId,
          payload: adminsCfgSyncOutbox.payload,
          serverDeletedAt: servers.deletedAt,
        })
        .from(adminsCfgSyncOutbox)
        .innerJoin(servers, eq(servers.id, adminsCfgSyncOutbox.serverId))
        .where(
          and(
            isNull(adminsCfgSyncOutbox.relayedAt),
            failedIds.length > 0 ? notInArray(adminsCfgSyncOutbox.id, failedIds) : undefined,
          ),
        )
        .orderBy(asc(adminsCfgSyncOutbox.createdAt))
        .limit(1)
        .for('update', { of: adminsCfgSyncOutbox, skipLocked: true });

      if (!row) return { kind: 'drained' };

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
        return { kind: 'cancelled' };
      }

      let streamId: string;
      try {
        streamId = await publishRow(redis, opts.streamPrefix, row, xaddTimeoutMs);
      } catch (err) {
        return { kind: 'failed', id: row.id, error: err as Error };
      }
      await tx
        .update(adminsCfgSyncOutbox)
        .set({ relayedAt: new Date(), streamId })
        .where(eq(adminsCfgSyncOutbox.id, row.id));
      return { kind: 'relayed' };
    });

    if (step.kind === 'drained') break;
    if (step.kind === 'failed') {
      failedIds.push(step.id);
      firstFailure ??= step.error;
      consecutiveFailures += 1;
      continue;
    }
    consecutiveFailures = 0;
    if (step.kind === 'relayed') relayed += 1;
  }

  if (firstFailure) throw firstFailure;
  return { relayed };
}

/**
 * Publishes one outbox row with a bounded `XADD`.
 *
 * @returns The stream entry id Redis assigned.
 * @throws When the payload is not a JSON object, the `XADD` fails, times out,
 *   or returns no id.
 */
async function publishRow(
  redis: OutboxRelayRedis,
  streamPrefix: string,
  row: { id: string; serverId: string; payload: unknown },
  xaddTimeoutMs: number,
): Promise<string> {
  if (!isJsonObject(row.payload)) {
    throw new Error('admins_cfg_outbox_invalid_payload');
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const streamId = await Promise.race([
    redis.xadd(
      `${streamPrefix}${row.serverId}`,
      '*',
      'event',
      JSON.stringify({ ...row.payload, _outbox_id: row.id }),
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
  return streamId;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
