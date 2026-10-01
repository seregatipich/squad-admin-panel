import { servers } from '@squad/db/schema';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { INTEGRATION_PERMISSION } from '../../lib/integrations-discord/common.js';

/** Per-server Discord status channels. */
const discordStatusChannelRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  // DISCORD-6 (#153): one status channel per server. The worker renames that
  // channel to the live server state, so the panel stores only which channel to
  // rename; NULL means "not configured" and the worker skips that server.
  fast.get(
    '/api/v1/integrations/discord/status-channels',
    { config: { permissions: [INTEGRATION_PERMISSION], audit: false } },
    async () => {
      const rows = await app.db
        .select({
          serverId: servers.id,
          displayName: servers.displayName,
          slug: servers.slug,
          statusChannelId: servers.statusChannelId,
        })
        .from(servers)
        .where(isNull(servers.deletedAt))
        .orderBy(asc(servers.displayName));
      return {
        items: rows.map((r) => ({
          server_id: r.serverId,
          display_name: r.displayName,
          slug: r.slug,
          channel_id: r.statusChannelId,
        })),
      };
    },
  );

  fast.put(
    '/api/v1/integrations/discord/servers/:serverId/status-channel',
    {
      schema: {
        params: z.object({ serverId: z.string().uuid() }),
        // A Discord snowflake is a 64-bit unsigned id, so it travels as digits-only text.
        body: z.object({
          channel_id: z
            .string()
            .trim()
            .regex(/^\d{1,32}$/)
            .nullable(),
        }),
      },
      config: {
        permissions: [INTEGRATION_PERMISSION],
        audit: { action: 'discord.status_channel.set', resource: 'server' },
      },
    },
    async (req, reply) => {
      const [before] = await app.db
        .select({ id: servers.id, statusChannelId: servers.statusChannelId })
        .from(servers)
        .where(and(eq(servers.id, req.params.serverId), isNull(servers.deletedAt)))
        .limit(1);
      if (!before) {
        reply.code(404);
        return { error: 'server_not_found' };
      }
      await app.db
        .update(servers)
        .set({ statusChannelId: req.body.channel_id })
        .where(eq(servers.id, req.params.serverId));
      req.auditSnapshots = {
        before: { channel_id: before.statusChannelId },
        after: { channel_id: req.body.channel_id },
      };
      return { ok: true, channel_id: req.body.channel_id };
    },
  );
};

export default discordStatusChannelRoutes;
