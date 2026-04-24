import { serverCredentials, servers } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const RN_DISABLED_PLUGINS = [
  'autoUpdateMods',
  'chatCommands',
  'voteMap',
  'warnings',
  'broadcasts',
  'autoKick',
  'squadLeader',
] as const;

const paramsSchema = z.object({ id: z.string().uuid() });

const internalRnsquadjsConfigRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/internal/rnsquadjs/config/:id',
    {
      config: { audit: false },
      schema: { params: paramsSchema },
    },
    async (req, reply) => {
      const peer = req.socket.remoteAddress ?? '';
      if (!LOOPBACK_ADDRESSES.has(peer)) {
        reply.code(403);
        return { error: 'forbidden' };
      }

      const { id } = req.params;
      const server = await app.db.query.servers.findFirst({
        where: eq(servers.id, id),
      });
      if (!server) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const creds = await app.db.query.serverCredentials.findFirst({
        where: eq(serverCredentials.serverId, id),
      });
      if (!creds) {
        reply.code(404);
        return { error: 'not_found' };
      }

      const rconCfgPath = `${PANEL_CONFIGS_ROOT}/${id}/ServerConfig/Rcon.cfg`;
      const rconCfg = await app.bridge.fileRead({ path: rconCfgPath });
      const passwordMatch = rconCfg.content.match(/^\s*Password\s*=\s*(.*)$/m);
      const password = passwordMatch?.[1]?.trim() ?? '';

      const disabledPlugins = Object.fromEntries(
        RN_DISABLED_PLUGINS.map((name) => [name, { enabled: false }]),
      );

      return {
        [id]: {
          id,
          host: '127.0.0.1',
          port: creds.rconPort,
          password,
          logFilePath: '/squad/Logs/SquadGame.log',
          adminsFilePath: '/squad/SquadGame/ServerConfig/Admins.cfg',
          mapsName: 'vanilla.json',
          mapsRegExp: '',
          plugins: {
            panelBridge: { enabled: true },
            ...disabledPlugins,
          },
        },
      };
    },
  );
};

export default internalRnsquadjsConfigRoutes;
