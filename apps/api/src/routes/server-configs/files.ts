import { serverCredentials, servers } from '@squad/db/schema';
import { ALLOWED_CONFIG_FILES, configFileClass } from '@squad/shared-config';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { maskConfigSecrets } from '../../lib/config-secrets.js';
import { LICENSE_KEY_MASK, LICENSE_PLACEHOLDER } from '../../lib/license-cfg.js';
import {
  configPath,
  fileWriteForbidden,
  hex,
  idParams,
  isAllowed,
  nameParams,
  sha256,
  userMessage,
} from '../../lib/server-configs/common.js';
import { writeVersion } from '../../lib/server-configs/write.js';

const bodySchema = z.object({
  content: z.string().max(1024 * 1024),
  message: userMessage.optional(),
  // Optional lost-update guard (#608): the sha256 the editor's content was
  // last loaded from. When present, the write is rejected with 409 if the
  // file on disk no longer matches it.
  base_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

/** Config file listing, current content and write. */
const serverConfigFilesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  // --------- list of files with behaviour class + current sha -----------
  fast.get(
    '/api/v1/servers/:id/configs',
    {
      config: { permissions: ['server:view'], audit: false },
      schema: { params: idParams },
    },
    async (req, reply) => {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
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
              sha256: hex(sha256(content)),
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

  // --------- current content of a single file --------------------------
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
      // SRV-6 (#45): License.cfg is panel-managed and holds the license key in
      // plaintext on disk. The editor never sees the disk bytes — the response
      // is re-rendered from server_credentials with the key masked.
      if (req.params.name === 'License.cfg') {
        const creds = await app.db.query.serverCredentials.findFirst({
          where: eq(serverCredentials.serverId, req.params.id),
        });
        const content = creds?.licenseKeyEncrypted
          ? `LicenseId=${creds.licenseId ?? ''}\nLicenseKey=${LICENSE_KEY_MASK}\n`
          : LICENSE_PLACEHOLDER;
        return {
          name: req.params.name,
          content,
          sha256: hex(sha256(content)),
          behavior: configFileClass(req.params.name),
        };
      }
      try {
        const { content } = await app.bridge.fileRead({
          path: configPath(req.params.id, req.params.name),
        });
        // #10: the RCON password in Rcon.cfg is masked like the license key;
        // the sha still describes the disk bytes so it matches what a PUT
        // reports and what drift detection compares.
        return {
          name: req.params.name,
          content: maskConfigSecrets(req.params.name, content),
          sha256: hex(sha256(content)),
          behavior: configFileClass(req.params.name),
        };
      } catch (err) {
        reply.code(404);
        return { error: 'file_not_found', detail: (err as Error).message };
      }
    },
  );

  // --------- write (creates new version) -------------------------------
  fast.put(
    '/api/v1/servers/:id/configs/:name',
    {
      config: {
        permissions: ['config:edit'],
        audit: { action: 'server.config.write', resource: 'server' },
      },
      schema: { params: nameParams, body: bodySchema },
    },
    async (req, reply) => {
      if (!isAllowed(req.params.name)) {
        reply.code(400);
        return { error: 'file_not_in_allowlist' };
      }
      // SRV-6 (#45): License.cfg is written exclusively by the server-settings
      // license flow (syncLicenseCfg); an editor PUT would either leak the key
      // into config_versions or clobber the real key on disk.
      if (req.params.name === 'License.cfg') {
        reply.code(400);
        return { error: 'panel_managed_file' };
      }
      const forbidden = fileWriteForbidden(req, reply, req.params.name);
      if (forbidden) return forbidden;
      if (req.body.base_sha256) {
        let diskSha256: string | null = null;
        try {
          const onDisk = await app.bridge.fileRead({
            path: configPath(req.params.id, req.params.name),
          });
          diskSha256 = hex(sha256(onDisk.content));
        } catch {
          diskSha256 = null;
        }
        if (diskSha256 !== req.body.base_sha256) {
          reply.code(409);
          return { error: 'stale_base', current_sha256: diskSha256 };
        }
      }
      return writeVersion(
        app,
        req.params.id,
        req.params.name,
        req.body.content,
        req.body.message ?? null,
        req.user?.playerId ?? null,
        req.ip ?? null,
      );
    },
  );
};

export default serverConfigFilesRoutes;
