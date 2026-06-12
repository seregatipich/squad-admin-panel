import { auditLog } from '@squad/db/schema';
import { desc } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

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
};

export default auditRoutes;
