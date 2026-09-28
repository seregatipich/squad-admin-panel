import { auditLog } from '@squad/db/schema';
import { desc, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type AuditChainRow, verifyAuditChain } from '../lib/audit-chain.js';

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
      const items = rows.map((r) => ({
        ...r,
        id: String(r.id),
        actor_player_id: r.actor_player_id ?? null,
      }));
      return {
        items,
        total: items.length,
        page,
        page_size,
      };
    },
  );

  fast.get(
    '/api/v1/audit/verify-chain',
    { config: { permissions: ['audit:view'], audit: false } },
    async () => {
      // audit_log is append-only and grows without bound (only the archiver
      // ever removes rows) — a single SELECT * FROM audit_log would
      // materialize the whole table, context::text included, in this API
      // process's memory. Walk it in fixed-size pages by id instead.
      const BATCH_SIZE = 5_000;
      let prevHashHex: string | null = null;
      let checked = 0;
      let lastId = '0';

      for (;;) {
        const rows = (await app.db.execute(sql`
          SELECT
            id::text AS id,
            action_type,
            target_type,
            target_id,
            context::text AS context_text,
            created_at::text AS created_at,
            encode(prev_hash, 'hex') AS prev_hash_hex,
            encode(row_hash, 'hex') AS row_hash_hex
          FROM audit_log
          WHERE id > ${lastId}
          ORDER BY audit_log.id ASC
          LIMIT ${BATCH_SIZE}
        `)) as unknown as AuditChainRow[];
        if (rows.length === 0) break;

        const result = verifyAuditChain(rows, prevHashHex);
        checked += result.checked;
        if (!result.ok) {
          return { ok: false, checked, broken_at: result.brokenAt, reason: result.reason };
        }
        prevHashHex = result.lastHashHex;
        // rows.length > 0, checked by the `break` right after fetching above.
        const lastRow = rows[rows.length - 1] as AuditChainRow;
        lastId = lastRow.id;
        if (rows.length < BATCH_SIZE) break;
      }

      return { ok: true, checked, broken_at: null, reason: null };
    },
  );
};

export default auditRoutes;
