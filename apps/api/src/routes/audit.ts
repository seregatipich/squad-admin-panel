import { setImmediate } from 'node:timers/promises';
import { auditLog } from '@squad/db/schema';
import { desc, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AUDIT_CHAIN_COLUMNS_SQL,
  type AuditChainRow,
  AuditChainVerifier,
} from '../lib/audit-chain.js';

/** Redis key that serialises `GET /api/v1/audit/verify-chain` runs. */
export const AUDIT_VERIFY_LOCK_KEY = 'audit:verify-chain:lock';
/** Upper bound on one verification; the lock expires even if the process dies mid-run. */
const AUDIT_VERIFY_LOCK_TTL_MS = 10 * 60_000;
/** Rows read and hashed per keyset page. */
const AUDIT_VERIFY_BATCH_SIZE = 5_000;

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

const auditRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  fast.get(
    '/api/v1/audit',
    {
      config: { permissions: ['audit:view'], audit: false },
      schema: { querystring: listQuery },
    },
    async (req) => {
      const { page, page_size } = req.query;
      const offset = (page - 1) * page_size;
      const rows = await app.db
        .select({
          id: auditLog.id,
          created_at: auditLog.createdAt,
          actor_kind: auditLog.actorKind,
          actor_player_id: auditLog.actorPlayerId,
          actor_token_id: auditLog.actorTokenId,
          actor_system_label: auditLog.actorSystemLabel,
          actor_ip: auditLog.actorIp,
          action_type: auditLog.actionType,
          target_type: auditLog.targetType,
          target_id: auditLog.targetId,
          context: auditLog.context,
          status_code: auditLog.statusCode,
          duration_ms: auditLog.durationMs,
          prev_hash: sql<string | null>`encode(${auditLog.prevHash}, 'hex')`,
          row_hash: sql<string>`encode(${auditLog.rowHash}, 'hex')`,
        })
        .from(auditLog)
        .orderBy(desc(auditLog.id))
        .limit(page_size)
        .offset(offset);
      // `total` counts the whole log (#94), matching the appeals/players list
      // contract, so a client can page past the first `page_size` rows.
      const [countRow] = await app.db.select({ total: sql<number>`count(*)::int` }).from(auditLog);
      const items = rows.map((r) => ({
        ...r,
        id: String(r.id),
        actor_player_id: r.actor_player_id ?? null,
      }));
      return {
        items,
        total: countRow?.total ?? 0,
        page,
        page_size,
      };
    },
  );

  /**
   * Verifies the whole audit hash chain. Reads `audit_log` in keyset pages of
   * {@link AUDIT_VERIFY_BATCH_SIZE} inside one read-only REPEATABLE READ
   * transaction (a consistent snapshot, `created_at::text` rendered in UTC as
   * the trigger hashes it), yields the event loop between pages, and runs
   * one verification at a time: a concurrent call answers
   * `409 verify_in_progress` (#36).
   */
  fast.get(
    '/api/v1/audit/verify-chain',
    { config: { permissions: ['audit:view'], audit: false } },
    async (req, reply) => {
      const acquired = await app.redis.set(
        AUDIT_VERIFY_LOCK_KEY,
        req.id,
        'PX',
        AUDIT_VERIFY_LOCK_TTL_MS,
        'NX',
      );
      if (acquired !== 'OK') {
        reply.code(409);
        return { error: 'verify_in_progress' };
      }
      try {
        const verifier = new AuditChainVerifier();
        await app.db.transaction(
          async (tx) => {
            await tx.execute(sql`SET LOCAL "TimeZone" = 'UTC'`);
            let cursor = '0';
            for (;;) {
              const rows = await tx.execute<AuditChainRow>(sql`
                SELECT ${sql.raw(AUDIT_CHAIN_COLUMNS_SQL)}
                FROM audit_log
                WHERE audit_log.id > ${cursor}::bigint
                -- Qualified: a bare id would sort by the id::text output column.
                ORDER BY audit_log.id ASC
                LIMIT ${AUDIT_VERIFY_BATCH_SIZE}
              `);
              const last = rows.at(-1);
              if (!last || !verifier.feed(rows)) return;
              cursor = last.id;
              await setImmediate();
            }
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
        const result = verifier.result();
        return {
          ok: result.ok,
          checked: result.checked,
          broken_at: result.brokenAt,
          reason: result.reason,
        };
      } finally {
        await app.redis.del(AUDIT_VERIFY_LOCK_KEY);
      }
    },
  );
};

export default auditRoutes;
