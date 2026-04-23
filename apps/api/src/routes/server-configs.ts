import { createHash } from 'node:crypto';
import { servers } from '@squad/db/schema';
import {
  ALLOWED_CONFIG_FILES,
  type AllowedConfigFile,
  configFileClass,
  PANEL_CONFIGS_ROOT,
} from '@squad/shared-config';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const idParams = z.object({ id: z.string().uuid() });
const nameParams = z.object({ id: z.string().uuid(), name: z.string().min(1).max(64) });
const bodySchema = z.object({
  content: z.string().max(1024 * 1024),
});

function isAllowed(name: string): name is AllowedConfigFile {
  return (ALLOWED_CONFIG_FILES as readonly string[]).includes(name);
}

function configPath(serverId: string, file: AllowedConfigFile): string {
  return `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/${file}`;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const serverConfigRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/servers/:id/configs',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: idParams },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: eq(servers.id, req.params.id),
      });
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      const items = await Promise.all(
        ALLOWED_CONFIG_FILES.map(async (name) => {
          try {
            const { content } = await app.bridge.fileRead({
              path: configPath(req.params.id, name),
            });
            return {
              name,
              size: Buffer.byteLength(content, 'utf-8'),
              sha256: sha256(content),
              behavior: configFileClass(name),
              exists: true,
            };
          } catch {
            return {
              name,
              size: 0,
              sha256: null,
              behavior: configFileClass(name),
              exists: false,
            };
          }
        }),
      );
      return { items };
    },
  );

  fast.get(
    '/api/v1/servers/:id/configs/:name',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: nameParams },
    },
    async (req, reply) => {
      if (!isAllowed(req.params.name)) {
        reply.code(400);
        return { error: 'file_not_in_allowlist' };
      }
      try {
        const { content } = await app.bridge.fileRead({
          path: configPath(req.params.id, req.params.name),
        });
        return {
          name: req.params.name,
          content,
          sha256: sha256(content),
          behavior: configFileClass(req.params.name),
        };
      } catch (err) {
        reply.code(404);
        return { error: 'file_not_found', detail: (err as Error).message };
      }
    },
  );

  fast.put(
    '/api/v1/servers/:id/configs/:name',
    {
      config: {
        permissions: ['server:config:write'],
        audit: { action: 'server.config.write', resource: 'server' },
      },
      schema: { params: nameParams, body: bodySchema },
    },
    async (req, reply) => {
      if (!isAllowed(req.params.name)) {
        reply.code(400);
        return { error: 'file_not_in_allowlist' };
      }
      let previousHash: string | null = null;
      try {
        const prev = await app.bridge.fileRead({
          path: configPath(req.params.id, req.params.name),
        });
        previousHash = sha256(prev.content);
      } catch {
        previousHash = null;
      }
      await app.bridge.fileAtomicWrite({
        path: configPath(req.params.id, req.params.name),
        content: req.body.content,
      });
      const newHash = sha256(req.body.content);
      return {
        ok: true,
        previous_sha256: previousHash,
        sha256: newHash,
        behavior: configFileClass(req.params.name),
      };
    },
  );
};

export default serverConfigRoutes;
