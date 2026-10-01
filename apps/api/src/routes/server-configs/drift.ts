import { configVersions, serverCredentials, servers } from '@squad/db/schema';
import type { AllowedConfigFile } from '@squad/shared-config';
import { createPatch } from 'diff';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { isFileNotFoundError } from '../../lib/bridge-file-errors.js';
import { maskConfigSecretsForDiff } from '../../lib/config-secrets.js';
import { decryptString, deserialize } from '../../lib/crypto.js';
import {
  configPath,
  DIFF_TIMEOUT_MS,
  fileWriteForbidden,
  hex,
  idParams,
  nameParams,
  restoreBody,
  sha256,
} from '../../lib/server-configs/common.js';
import type { DriftState } from '../../lib/server-configs/drift.js';
import {
  DRIFT_SWEEP_FILES,
  driftGuardError,
  readTipVersion,
} from '../../lib/server-configs/drift.js';
import { writeVersion } from '../../lib/server-configs/write.js';
import { depotConfigDir, rewriteRconCfg, rewriteServerCfg } from '../server-install.js';

/** Config drift detection and resolution, and reset to the depot default. */
const serverConfigDriftRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  // ---------------------------------------------------------------------
  // CFG-2 (#64): generic drift detection + resolution for the non-managed
  // config files. No git anywhere — the `config_versions` tip is the panel's
  // source of truth; drift is "disk sha256 != tip sha256".
  // ---------------------------------------------------------------------

  // --------- drift status for the whole sweep set (reads live) ---------
  fast.get(
    '/api/v1/servers/:id/configs/drift',
    {
      config: { permissions: ['config:view'], audit: false },
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
      // #1335: one tip row per file (DISTINCT ON over the server_file_time
      // index), not the whole append-only history of the server.
      const tipRows = await app.db
        .selectDistinctOn([configVersions.filename], {
          id: configVersions.id,
          filename: configVersions.filename,
          sha: configVersions.sha256,
        })
        .from(configVersions)
        .where(eq(configVersions.serverId, req.params.id))
        .orderBy(configVersions.filename, desc(configVersions.createdAt));
      const tipByFile = new Map<string, { id: string; sha: string | null }>();
      for (const t of tipRows) {
        tipByFile.set(t.filename, { id: t.id, sha: hex(t.sha) });
      }
      const items = await Promise.all(
        DRIFT_SWEEP_FILES.map(async (name) => {
          const tip = tipByFile.get(name) ?? null;
          let diskSha: string | null = null;
          let readError: unknown = null;
          try {
            const { content } = await app.bridge.fileRead({
              path: configPath(req.params.id, name),
            });
            diskSha = hex(sha256(content));
          } catch (err) {
            readError = err;
          }
          let state: DriftState;
          if (!tip) {
            state = 'unknown';
          } else if (readError) {
            state = isFileNotFoundError(readError) ? 'missing' : 'unreachable';
          } else {
            state = diskSha === tip.sha ? 'in_sync' : 'drift';
          }
          return {
            name,
            state,
            disk_sha256: diskSha,
            version_sha256: tip?.sha ?? null,
            tip_version_id: tip?.id ?? null,
          };
        }),
      );
      return { items, checked_at: new Date().toISOString() };
    },
  );

  // --------- unified diff: DB tip vs. current disk bytes ---------------
  fast.get(
    '/api/v1/servers/:id/configs/:name/drift/diff',
    {
      config: { permissions: ['config:view'], audit: false },
      schema: { params: nameParams },
    },
    async (req, reply) => {
      const guard = driftGuardError(req.params.name);
      if (guard) {
        reply.code(400);
        return { error: guard };
      }
      const tip = await readTipVersion(app, req.params.id, req.params.name);
      if (!tip) {
        reply.code(404);
        return { error: 'version_not_found' };
      }
      let disk: string;
      try {
        disk = (
          await app.bridge.fileRead({
            path: configPath(req.params.id, req.params.name as AllowedConfigFile),
          })
        ).content;
      } catch (err) {
        reply.code(404);
        return { error: 'file_not_found', detail: (err as Error).message };
      }
      const [maskedTip, maskedDisk] = await maskConfigSecretsForDiff(
        app,
        req.params.id,
        req.params.name,
        tip.content,
        disk,
      );
      const diff = createPatch(req.params.name, maskedTip, maskedDisk, 'panel', 'disk', {
        timeout: DIFF_TIMEOUT_MS,
      });
      if (diff === undefined) {
        reply.code(422);
        return { error: 'diff_too_large' };
      }
      return { name: req.params.name, diff };
    },
  );

  // --------- accept: record the disk bytes as a new version ------------
  fast.post(
    '/api/v1/servers/:id/configs/:name/drift/accept',
    {
      config: {
        permissions: ['config:edit'],
        audit: { action: 'server.config.drift_accept', resource: 'server' },
      },
      schema: { params: nameParams, body: restoreBody },
    },
    async (req, reply) => {
      const guard = driftGuardError(req.params.name);
      if (guard) {
        reply.code(400);
        return { error: guard };
      }
      const forbidden = fileWriteForbidden(req, reply, req.params.name as AllowedConfigFile);
      if (forbidden) return forbidden;
      let disk: string;
      try {
        disk = (
          await app.bridge.fileRead({
            path: configPath(req.params.id, req.params.name as AllowedConfigFile),
          })
        ).content;
      } catch (err) {
        reply.code(404);
        return { error: 'file_not_found', detail: (err as Error).message };
      }
      const tip = await readTipVersion(app, req.params.id, req.params.name);
      if (tip && Buffer.from(tip.sha).equals(sha256(disk))) {
        reply.code(409);
        return { error: 'no_drift' };
      }
      // writeVersion re-applies the identical bytes via fileAtomicWrite, so
      // the disk content is untouched while history gains the new row.
      return writeVersion(
        app,
        req.params.id,
        req.params.name as AllowedConfigFile,
        disk,
        req.body?.message ?? 'accept out-of-band disk change',
        req.user?.playerId ?? null,
        req.ip ?? null,
      );
    },
  );

  // --------- revert: repair the disk back to the DB tip ----------------
  fast.post(
    '/api/v1/servers/:id/configs/:name/drift/revert',
    {
      config: {
        permissions: ['config:rollback'],
        audit: { action: 'server.config.drift_revert', resource: 'server' },
      },
      schema: { params: nameParams, body: restoreBody },
    },
    async (req, reply) => {
      const guard = driftGuardError(req.params.name);
      if (guard) {
        reply.code(400);
        return { error: guard };
      }
      const forbidden = fileWriteForbidden(req, reply, req.params.name as AllowedConfigFile);
      if (forbidden) return forbidden;
      const tip = await readTipVersion(app, req.params.id, req.params.name);
      if (!tip) {
        reply.code(404);
        return { error: 'version_not_found' };
      }
      // A failing/absent read counts as drift: the repair below rewrites the
      // file either way.
      let diskInSync = false;
      try {
        const { content } = await app.bridge.fileRead({
          path: configPath(req.params.id, req.params.name as AllowedConfigFile),
        });
        diskInSync = sha256(content).equals(Buffer.from(tip.sha));
      } catch {
        diskInSync = false;
      }
      if (diskInSync) {
        reply.code(409);
        return { error: 'no_drift' };
      }
      // force: the tip content matches the DB tip sha by construction, so the
      // dedup branch is taken — the force flag makes it repair the disk
      // byte-for-byte without appending a duplicate history row. A masked
      // Rcon.cfg tip is filled with the panel's password, not the drifted one
      // on disk (#10, #280).
      return writeVersion(
        app,
        req.params.id,
        req.params.name as AllowedConfigFile,
        tip.content,
        req.body?.message ?? `revert to panel version ${tip.id.slice(0, 8)}`,
        req.user?.playerId ?? null,
        req.ip ?? null,
        { force: true },
      );
    },
  );

  // --------- reset to the SteamCMD depot default template --------------
  fast.post(
    '/api/v1/servers/:id/configs/:name/reset-default',
    {
      config: {
        permissions: ['config:edit'],
        audit: { action: 'server.config.reset_default', resource: 'server' },
      },
      schema: { params: nameParams, body: restoreBody },
    },
    async (req, reply) => {
      const guard = driftGuardError(req.params.name);
      if (guard) {
        reply.code(400);
        return { error: guard };
      }
      const forbidden = fileWriteForbidden(req, reply, req.params.name as AllowedConfigFile);
      if (forbidden) return forbidden;
      let content: string;
      try {
        content = (await app.bridge.fileRead({ path: `${depotConfigDir()}/${req.params.name}` }))
          .content;
      } catch {
        reply.code(422);
        return { error: 'depot_default_unavailable' };
      }
      // Re-apply the install-time rewrites (server-install.ts seedConfigs):
      // without them a reset would clobber the live RCON port/password or the
      // panel-assigned server name with depot placeholders.
      if (req.params.name === 'Rcon.cfg') {
        const creds = await app.db.query.serverCredentials.findFirst({
          where: eq(serverCredentials.serverId, req.params.id),
        });
        if (!creds?.rconPasswordEncrypted) {
          reply.code(422);
          return { error: 'depot_default_unavailable' };
        }
        const password = decryptString(
          app.encryptionKey,
          deserialize(Buffer.from(creds.rconPasswordEncrypted)),
        );
        content = rewriteRconCfg(content, { port: creds.rconPort, password });
      } else if (req.params.name === 'Server.cfg') {
        const row = await app.db.query.servers.findFirst({
          where: and(eq(servers.id, req.params.id), isNull(servers.deletedAt)),
        });
        if (!row) {
          reply.code(404);
          return { error: 'not_found' };
        }
        content = rewriteServerCfg(content, row.displayName);
      }
      return writeVersion(
        app,
        req.params.id,
        req.params.name as AllowedConfigFile,
        content,
        req.body?.message ?? 'reset to depot default',
        req.user?.playerId ?? null,
        req.ip ?? null,
      );
    },
  );
};

export default serverConfigDriftRoutes;
