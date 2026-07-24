import { chatCommandInvocations, players, servers } from '@squad/db/schema';
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const serverIdParams = z.object({ id: z.string().uuid() });

const historyQuery = z.object({
  command: z.enum(['stats', 'rules', 'report']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

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

/**
 * AUTO-4 (#75): read-only history of in-game chat commands (`!stats`, `!rules`,
 * `!report`) recognized by `@squad/worker-log-ingest`
 * (`apps/workers/log-ingest/src/chat/commands.ts`). The rows are written by the
 * worker; this route only surfaces them. The `!rules` reply text and the
 * per-server `chat_commands_enabled` toggle live on `server_settings` and are
 * managed via `PUT /api/v1/servers/:id/settings`.
 */
const serverChatCommandsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/servers/:id/chat-commands',
    { config: { audit: false }, schema: { params: serverIdParams, querystring: historyQuery } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const server = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
      });
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const from = req.query.from ? new Date(req.query.from) : null;
      const to = req.query.to ? new Date(req.query.to) : null;
      const rows = await app.db
        .select({
          id: chatCommandInvocations.id,
          command: chatCommandInvocations.command,
          args: chatCommandInvocations.args,
          responded: chatCommandInvocations.responded,
          responseSource: chatCommandInvocations.responseSource,
          createdAt: chatCommandInvocations.createdAt,
          playerId: chatCommandInvocations.playerId,
          playerName: players.canonicalName,
        })
        .from(chatCommandInvocations)
        .leftJoin(players, eq(players.id, chatCommandInvocations.playerId))
        .where(
          and(
            eq(chatCommandInvocations.serverId, req.params.id),
            ...(req.query.command ? [eq(chatCommandInvocations.command, req.query.command)] : []),
            ...(from ? [gte(chatCommandInvocations.createdAt, from)] : []),
            ...(to ? [lte(chatCommandInvocations.createdAt, to)] : []),
          ),
        )
        .orderBy(desc(chatCommandInvocations.createdAt))
        .limit(req.query.limit ?? 100);

      return {
        invocations: rows.map((row) => ({
          id: row.id,
          command: row.command,
          args: row.args,
          responded: row.responded,
          response_source: row.responseSource,
          created_at: row.createdAt.toISOString(),
          player_id: row.playerId,
          player_name: row.playerName,
        })),
      };
    },
  );
};

export default serverChatCommandsRoutes;
