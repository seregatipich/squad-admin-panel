import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const LIMIT_MAX = 200;
const LIMIT_DEFAULT = 50;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
});

interface ModerationActionApiRow {
  id: string;
  action_type: string;
  reason: string | null;
  context: unknown;
  created_at: Date | string;
  reverted_at: Date | string | null;
  server_id: string | null;
  server_name: string | null;
  author_player_id: string | null;
  author_name: string | null;
  author_system_label: string | null;
}

function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Moderation history routes. Serves the per-player moderation ledger
 * (`moderation_actions`) that backs the "moderation history" block on the
 * player card: the most recent enforcement actions taken against a player,
 * automated or manual, with the resolved author. Gated on `panel_access`.
 */
const moderationActionsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/moderation-actions',
    { schema: { params: playerIdParams, querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { playerId } = req.params;
      const { limit } = req.query;

      const rows = (await app.db.execute(sql`
        SELECT
          ma.id,
          ma.action_type,
          ma.reason,
          ma.context,
          ma.created_at,
          ma.reverted_at,
          ma.server_id,
          s.display_name AS server_name,
          ma.author_player_id,
          ap.canonical_name AS author_name,
          ma.author_system_label
        FROM moderation_actions ma
        LEFT JOIN players ap ON ap.id = ma.author_player_id
        LEFT JOIN servers s ON s.id = ma.server_id
        WHERE ma.player_id = ${playerId}
        ORDER BY ma.created_at DESC, ma.id DESC
        LIMIT ${limit}
      `)) as unknown as ModerationActionApiRow[];

      return {
        actions: rows.map((row) => ({
          id: row.id,
          action_type: row.action_type,
          reason: row.reason,
          context: row.context ?? {},
          created_at: toIso(row.created_at),
          reverted_at: toIso(row.reverted_at),
          server: row.server_id ? { id: row.server_id, name: row.server_name } : null,
          author: row.author_player_id
            ? { kind: 'player' as const, id: row.author_player_id, name: row.author_name }
            : { kind: 'system' as const, label: row.author_system_label },
        })),
      };
    },
  );
};

export default moderationActionsRoutes;
