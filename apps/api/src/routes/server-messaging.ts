import { chatMessages } from '@squad/db/schema';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import { sendRconCommandViaWorker } from '../lib/rcon-worker-command.js';
import { parseStoredRoster } from '../lib/roster.js';

const MESSAGE_MIN = 2;
const MESSAGE_MAX = 300;

const serverIdParams = z.object({ serverId: z.string().uuid() });
const squadParams = z.object({
  serverId: z.string().uuid(),
  squadId: z.coerce.number().int(),
});
// team_id disambiguates squads: Squad numbers squads per-team (both teams have
// a "Squad 1"), so squad_id alone does not identify a unique in-game squad.
const squadQuery = z.object({ team_id: z.coerce.number().int() });
const messageBody = z.object({ message: z.string().trim().min(MESSAGE_MIN).max(MESSAGE_MAX) });

interface RecipientOutcome {
  target: string;
  name: string;
  ok: boolean;
  reason?: string;
}

function hasChatPermission(req: FastifyRequest): boolean {
  return req.user?.permissions.squadPermissions.has('chat') ?? false;
}

const serverMessagingRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function auditMessagingAction(
    req: FastifyRequest,
    reply: FastifyReply,
    input: { actionType: string; serverId: string; after: unknown },
  ): Promise<void> {
    if (!req.user) return;
    await writeAuditEntry(app.db, {
      actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
      actorIp: req.ip ?? null,
      actionType: input.actionType,
      targetType: 'server',
      targetId: input.serverId,
      after: input.after,
      context: { requestId: req.id, method: req.method, url: req.url },
      statusCode: reply.statusCode,
    });
  }

  /**
   * Sends a server-wide message via RCON `AdminBroadcast`, routed through the
   * worker-rcon command queue. On success, records the broadcast in
   * `chat_messages` (scope: broadcast, source: panel) and writes an audit
   * log entry. Requires the 'chat' squad permission.
   */
  fast.post(
    '/api/v1/servers/:serverId/broadcast',
    {
      schema: { params: serverIdParams, body: messageBody },
      config: { audit: false },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!hasChatPermission(req)) {
        reply.code(403);
        return { error: 'forbidden', required_squad_permission: 'chat' };
      }

      const { serverId } = req.params;
      const message = req.body.message;

      const viaWorker = await sendRconCommandViaWorker(app.redis, {
        serverId,
        command: 'AdminBroadcast',
        args: [message],
        actorPlayerId: req.user.playerId,
      });

      if (!viaWorker.attempted || !viaWorker.ok) {
        reply.code(502);
        return {
          error: 'broadcast_failed',
          reason: viaWorker.reason,
          detail: viaWorker.detail,
        };
      }

      const sentAt = new Date();
      await app.db.insert(chatMessages).values({
        playerId: req.user.playerId,
        serverId,
        scope: 'broadcast',
        source: 'panel',
        message,
        sentAt,
      });

      await auditMessagingAction(req, reply, {
        actionType: 'server.broadcast',
        serverId,
        after: { message },
      });

      return { ok: true, request_id: viaWorker.requestId, response: viaWorker.response };
    },
  );

  /**
   * Sends an in-game warning (RCON `AdminWarn`) to every player currently in
   * the given squad, as read from the live roster cached in Redis. The squad
   * is identified by (`team_id`, `squadId`) since Squad numbers squads
   * per-team. The member set is read fresh on every call — nothing is
   * cached across requests — so repeated calls always reflect the current
   * roster. Requires the 'chat' squad permission.
   */
  fast.post(
    '/api/v1/servers/:serverId/squads/:squadId/message',
    {
      schema: { params: squadParams, querystring: squadQuery, body: messageBody },
      config: { audit: false },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!hasChatPermission(req)) {
        reply.code(403);
        return { error: 'forbidden', required_squad_permission: 'chat' };
      }

      const { serverId, squadId } = req.params;
      const { team_id } = req.query;
      const message = req.body.message;

      const stored = parseStoredRoster(await app.redis.get(`rcon:roster:${serverId}`));
      const members = (stored?.players ?? []).filter(
        (entry) => entry.squad_id === squadId && entry.team_id === team_id,
      );

      const recipients: RecipientOutcome[] = [];
      for (const member of members) {
        const target = member.eos_id || member.steam_id64 || member.name;
        const viaWorker = await sendRconCommandViaWorker(app.redis, {
          serverId,
          command: 'AdminWarn',
          args: [target, message],
          actorPlayerId: req.user.playerId,
        });
        recipients.push({
          target,
          name: member.name,
          ok: viaWorker.attempted && viaWorker.ok,
          reason: viaWorker.attempted
            ? viaWorker.ok
              ? undefined
              : viaWorker.reason
            : viaWorker.reason,
        });
      }

      await auditMessagingAction(req, reply, {
        actionType: 'server.squad_message',
        serverId,
        after: { squad_id: squadId, team_id, message, recipients },
      });

      return { ok: true, squad_id: squadId, team_id, recipients };
    },
  );
};

export default serverMessagingRoutes;
