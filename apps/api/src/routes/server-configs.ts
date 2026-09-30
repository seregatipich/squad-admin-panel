import { createHash } from 'node:crypto';
import {
  type AdminsCfgSyncTransaction,
  type DatabaseClient,
  withAdminsCfgServerLock,
} from '@squad/db';
import { configVersions, players, serverCredentials, servers } from '@squad/db/schema';
import {
  ALLOWED_CONFIG_FILES,
  type AllowedConfigFile,
  configFileClass,
  PANEL_CONFIGS_ROOT,
  type PermissionKey,
} from '@squad/shared-config';
import { createPatch } from 'diff';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BLAME_MAX_VERSIONS, type BlameVersion, computeBlame } from '../lib/blame.js';
import { isFileNotFoundError } from '../lib/bridge-file-errors.js';
import {
  assertRconCredentialsUnchanged,
  maskConfigSecrets,
  maskConfigSecretsForDiff,
  unmaskRconPassword,
} from '../lib/config-secrets.js';
import { decryptString, deserialize } from '../lib/crypto.js';
import { LICENSE_KEY_MASK, LICENSE_PLACEHOLDER } from '../lib/license-cfg.js';
import { resolveRconHost } from '../lib/rcon-host.js';
import { rconSendOnce } from '../lib/rcon-send.js';
import { sendRconCommandViaWorker } from '../lib/rcon-worker-command.js';
import { DELETION_BACKUP_MARKER } from '../lib/server-delete.js';
import { containerOnlyPreHandler } from '../lib/server-runtime.js';
import { depotConfigDir, rewriteRconCfg, rewriteServerCfg } from './server-install.js';

const idParams = z.object({ id: z.string().uuid() });
const nameParams = z.object({ id: z.string().uuid(), name: z.string().min(1).max(64) });
const versionParams = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  vid: z.string().uuid(),
});
const diffQuery = z.object({ from: z.string().uuid(), to: z.string().uuid() });
// #281: a user message must not pass for a deletion backup, which archive
// restore selects by its message prefix.
const userMessage = z
  .string()
  .max(500)
  .refine((m) => !m.trim().toLowerCase().startsWith(DELETION_BACKUP_MARKER), {
    message: 'reserved_message_prefix',
  });
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
const restoreBody = z.object({ message: userMessage.optional() }).default({ message: undefined });

/**
 * Wall-clock budget for one diff or blame computation (#283). Myers diffing is
 * synchronous and O((N+M)·D), so without a bound two large unrelated versions
 * block the event loop for minutes.
 */
const DIFF_TIMEOUT_MS = 2_000;

/**
 * Files whose content grants what a separate permission guards (#1236): a
 * `Bans.cfg` line or a remote ban list bans a player, and an `Admins.cfg` line
 * or a remote admin list grants Squad admin rights. `config:edit` alone must
 * not bypass `mod:ban_perm` (squad `ban`) or `user:manage_roles`
 * (`can_assign_roles`).
 */
const FILE_WRITE_PERMISSION: Partial<Record<AllowedConfigFile, PermissionKey>> = {
  'Bans.cfg': 'mod:ban_perm',
  'RemoteBanListHosts.cfg': 'mod:ban_perm',
  'Admins.cfg': 'user:manage_roles',
  'RemoteAdminListHosts.cfg': 'user:manage_roles',
};

/**
 * Checks the per-file permission a write to `name` needs on top of the
 * route's own (#1236) and sets 403 on `reply` when the caller lacks it.
 *
 * @returns The 403 body to send, or null when the write may proceed.
 */
function fileWriteForbidden(
  req: FastifyRequest,
  reply: FastifyReply,
  name: AllowedConfigFile,
): { error: 'forbidden'; required_permission: PermissionKey } | null {
  const required = FILE_WRITE_PERMISSION[name];
  if (!required || req.user?.permissions.permissions.has(required)) return null;
  reply.code(403);
  return { error: 'forbidden', required_permission: required };
}

function isAllowed(name: string): name is AllowedConfigFile {
  return (ALLOWED_CONFIG_FILES as readonly string[]).includes(name);
}

function configPath(serverId: string, file: AllowedConfigFile): string {
  return `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/${file}`;
}

function sha256(content: string): Buffer {
  return createHash('sha256').update(content).digest();
}

function hex(b: Buffer | Uint8Array | null): string | null {
  return b ? Buffer.from(b).toString('hex') : null;
}

const serverConfigRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  // Every `:id` in this plugin is a server id; an external server has no
  // container/config tree here, so refuse up front with 409 external_server.
  fast.addHook('preHandler', containerOnlyPreHandler(app));

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

  // --------- history: list of versions for a file ----------------------
  fast.get(
    '/api/v1/servers/:id/configs/:name/history',
    {
      config: { permissions: ['config:view'], audit: false },
      schema: {
        params: nameParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      },
    },
    async (req, reply) => {
      if (!isAllowed(req.params.name)) {
        reply.code(400);
        return { error: 'file_not_in_allowlist' };
      }
      const rows = await app.db
        .select({
          id: configVersions.id,
          sha256: configVersions.sha256,
          parent_version_id: configVersions.parentVersionId,
          author_player_id: configVersions.authorPlayerId,
          author_label: configVersions.authorLabel,
          author_canonical_name: players.canonicalName,
          author_ip: configVersions.authorIp,
          message: configVersions.message,
          created_at: configVersions.createdAt,
          size: sql<number>`octet_length(${configVersions.content})`,
        })
        .from(configVersions)
        .leftJoin(players, eq(players.id, configVersions.authorPlayerId))
        .where(
          and(
            eq(configVersions.serverId, req.params.id),
            eq(configVersions.filename, req.params.name),
          ),
        )
        .orderBy(desc(configVersions.createdAt))
        .limit(req.query.limit);
      const items = rows.map((r) => ({
        id: r.id,
        sha256: hex(r.sha256 as unknown as Buffer),
        parent_version_id: r.parent_version_id,
        author_player_id: r.author_player_id ?? null,
        author_canonical_name: r.author_canonical_name ?? r.author_label ?? 'system',
        author_ip: r.author_ip,
        message: r.message,
        created_at: r.created_at,
        size: Number(r.size),
      }));
      return { items, total: items.length };
    },
  );

  // --------- single version content ------------------------------------
  fast.get(
    '/api/v1/servers/:id/configs/:name/versions/:vid',
    {
      config: { permissions: ['config:view'], audit: false },
      schema: { params: versionParams },
    },
    async (req, reply) => {
      if (!isAllowed(req.params.name)) {
        reply.code(400);
        return { error: 'file_not_in_allowlist' };
      }
      const row = await app.db.query.configVersions.findFirst({
        where: and(
          eq(configVersions.id, req.params.vid),
          eq(configVersions.serverId, req.params.id),
          eq(configVersions.filename, req.params.name),
        ),
      });
      if (!row) {
        reply.code(404);
        return { error: 'version_not_found' };
      }
      // #10: rows written before masking still hold plaintext secrets.
      return {
        id: row.id,
        content: maskConfigSecrets(req.params.name, row.content),
        sha256: hex(row.sha256 as unknown as Buffer),
        author_player_id: row.authorPlayerId ?? null,
        message: row.message,
        created_at: row.createdAt,
      };
    },
  );

  // --------- diff between two versions ---------------------------------
  fast.get(
    '/api/v1/servers/:id/configs/:name/diff',
    {
      config: { permissions: ['config:view'], audit: false },
      schema: { params: nameParams, querystring: diffQuery },
    },
    async (req, reply) => {
      if (!isAllowed(req.params.name)) {
        reply.code(400);
        return { error: 'file_not_in_allowlist' };
      }
      const rows = await app.db
        .select({ id: configVersions.id, content: configVersions.content })
        .from(configVersions)
        .where(
          and(
            eq(configVersions.serverId, req.params.id),
            eq(configVersions.filename, req.params.name),
            inArray(configVersions.id, [req.query.from, req.query.to]),
          ),
        );
      const fromRow = rows.find((r) => r.id === req.query.from);
      const toRow = rows.find((r) => r.id === req.query.to);
      if (!fromRow || !toRow) {
        reply.code(404);
        return { error: 'version_not_found' };
      }
      const patch = createPatch(
        req.params.name,
        maskConfigSecrets(req.params.name, fromRow.content),
        maskConfigSecrets(req.params.name, toRow.content),
        fromRow.id.slice(0, 8),
        toRow.id.slice(0, 8),
        { timeout: DIFF_TIMEOUT_MS },
      );
      if (patch === undefined) {
        reply.code(422);
        return { error: 'diff_too_large' };
      }
      return { patch, from: fromRow.id, to: toRow.id };
    },
  );

  // --------- blame: tip content with per-line attribution --------------
  fast.get(
    '/api/v1/servers/:id/configs/:name/blame',
    {
      config: { permissions: ['config:view'], audit: false },
      schema: { params: nameParams },
    },
    async (req, reply) => {
      if (!isAllowed(req.params.name)) {
        reply.code(400);
        return { error: 'file_not_in_allowlist' };
      }
      const tip = await app.db
        .select({ id: configVersions.id })
        .from(configVersions)
        .where(
          and(
            eq(configVersions.serverId, req.params.id),
            eq(configVersions.filename, req.params.name),
          ),
        )
        .orderBy(desc(configVersions.createdAt), desc(configVersions.id))
        .limit(1);
      if (tip.length === 0) {
        return { lines: [], authors: {}, truncated: false };
      }
      const tipId = tip[0]?.id;
      // v2 (#10): payloads cached before masking may hold plaintext secrets.
      // v3 (#36): payloads carry `truncated`.
      const cacheKey = `config-blame:v3:${tipId}`;
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
      const rows = await app.db
        .select({
          id: configVersions.id,
          content: configVersions.content,
          author_player_id: configVersions.authorPlayerId,
          author_label: configVersions.authorLabel,
          created_at: configVersions.createdAt,
        })
        .from(configVersions)
        .where(
          and(
            eq(configVersions.serverId, req.params.id),
            eq(configVersions.filename, req.params.name),
          ),
        )
        // Newest window first, ordered on the full-precision timestamp; one
        // extra row tells whether older history was cut off (#36).
        .orderBy(desc(configVersions.createdAt), desc(configVersions.id))
        .limit(BLAME_MAX_VERSIONS + 1);
      const truncated = rows.length > BLAME_MAX_VERSIONS;
      const window = rows.slice(0, BLAME_MAX_VERSIONS).reverse();
      const vs: BlameVersion[] = window.map((r) => ({
        id: r.id,
        content: maskConfigSecrets(req.params.name, r.content),
        author_player_id: r.author_player_id ?? null,
        author_label: r.author_label,
        created_at: (r.created_at as Date).toISOString(),
      }));
      const lines = computeBlame(vs, { timeoutMs: DIFF_TIMEOUT_MS });
      if (!lines) {
        reply.code(422);
        return { error: 'diff_too_large' };
      }
      const playerIds = Array.from(
        new Set(lines.map((l) => l.author_player_id).filter((v): v is string => !!v)),
      );
      const playerRows =
        playerIds.length > 0
          ? await app.db
              .select({ id: players.id, canonicalName: players.canonicalName })
              .from(players)
              .where(inArrayOr(players.id, playerIds))
          : [];
      const authors: Record<string, string> = {};
      for (const r of playerRows) authors[r.id] = r.canonicalName;
      const payload = { lines, authors, truncated };
      await app.redis.set(cacheKey, JSON.stringify(payload), 'EX', 24 * 3600);
      return payload;
    },
  );

  // --------- restore: creates a NEW version with the old content -------
  fast.post(
    '/api/v1/servers/:id/configs/:name/restore/:vid',
    {
      config: {
        permissions: ['config:rollback'],
        audit: { action: 'server.config.restore', resource: 'server' },
      },
      schema: { params: versionParams, body: restoreBody },
    },
    async (req, reply) => {
      if (!isAllowed(req.params.name)) {
        reply.code(400);
        return { error: 'file_not_in_allowlist' };
      }
      // SRV-6 (#45): License.cfg history rows are masked; restoring one would
      // write `LicenseKey=********` over the real key on disk.
      if (req.params.name === 'License.cfg') {
        reply.code(400);
        return { error: 'panel_managed_file' };
      }
      const forbidden = fileWriteForbidden(req, reply, req.params.name);
      if (forbidden) return forbidden;
      const target = await app.db.query.configVersions.findFirst({
        where: and(
          eq(configVersions.id, req.params.vid),
          eq(configVersions.serverId, req.params.id),
          eq(configVersions.filename, req.params.name),
        ),
      });
      if (!target) {
        reply.code(404);
        return { error: 'version_not_found' };
      }
      const message = req.body?.message ?? `restore from version ${target.id.slice(0, 8)}`;
      return writeVersion(
        app,
        req.params.id,
        req.params.name as AllowedConfigFile,
        target.content,
        message,
        req.user?.playerId ?? null,
        req.ip ?? null,
      );
    },
  );

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
        tipByFile.set(t.filename, { id: t.id, sha: hex(t.sha as unknown as Buffer) });
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
      if (tip && Buffer.from(tip.sha as unknown as Buffer).equals(sha256(disk))) {
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
        diskInSync = sha256(content).equals(Buffer.from(tip.sha as unknown as Buffer));
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
          deserialize(Buffer.from(creds.rconPasswordEncrypted as unknown as Buffer)),
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

/** Managed-segment files (SYNC-3/4, ROT-2) — their drift story is owned by
 *  the dedicated machinery, not the generic CFG-2 sweep. */
const MANAGED_SEGMENT_FILES: readonly string[] = ['Admins.cfg', 'LayerRotation.cfg'];

/**
 * The generic drift sweep set (CFG-2, #64): every allowlisted config file
 * except the managed-segment files and the panel-managed `License.cfg` (#45).
 * Mirrored by the config-sync worker's `config-drift.ts` sweep.
 */
export const DRIFT_SWEEP_FILES: readonly AllowedConfigFile[] = ALLOWED_CONFIG_FILES.filter(
  (f) => f !== 'License.cfg' && !MANAGED_SEGMENT_FILES.includes(f),
);

type DriftState = 'in_sync' | 'drift' | 'missing' | 'unreachable' | 'unknown';

function driftGuardError(
  name: string,
): 'file_not_in_allowlist' | 'panel_managed_file' | 'managed_file' | null {
  if (!isAllowed(name)) return 'file_not_in_allowlist';
  if (name === 'License.cfg') return 'panel_managed_file';
  if (MANAGED_SEGMENT_FILES.includes(name)) return 'managed_file';
  return null;
}

async function readTipVersion(
  app: FastifyInstance,
  serverId: string,
  name: string,
): Promise<{ id: string; content: string; sha: Buffer } | null> {
  const rows = await app.db
    .select({ id: configVersions.id, content: configVersions.content, sha: configVersions.sha256 })
    .from(configVersions)
    .where(and(eq(configVersions.serverId, serverId), eq(configVersions.filename, name)))
    .orderBy(desc(configVersions.createdAt))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, content: row.content, sha: row.sha as unknown as Buffer } : null;
}

function inArrayOr<T>(col: Parameters<typeof inArray>[0], values: T[]) {
  if (values.length === 0) throw new Error('empty values');
  return inArray(col, values as Parameters<typeof inArray>[1]);
}

/**
 * Thrown by {@link writeVersion} when the server does not exist or is
 * soft-deleted (#281): the bridge would recreate its config directory and the
 * history row would land on an archived server.
 */
export class ConfigServerNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('not_found');
    this.name = 'ConfigServerNotFoundError';
  }
}

/**
 * Runs `work` in a transaction holding a per-(server, file) advisory lock, so
 * two writes of one file cannot interleave their disk write and history
 * insert (#282). The lock is released at commit or rollback.
 */
async function withConfigFileLock<T>(
  db: DatabaseClient,
  serverId: string,
  name: AllowedConfigFile,
  work: (tx: AdminsCfgSyncTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('config-write:' || ${serverId} || ':' || ${name}, 0))`,
    );
    return work(tx);
  });
}

/**
 * Writes a new config version: dedups against the current tip by sha256,
 * otherwise inserts a `config_versions` row and persists the bytes via
 * `bridge.fileAtomicWrite`, then best-effort pushes the change live via
 * `AdminReloadServerConfig`.
 *
 * The existence check, the tip read, the insert and the disk write run in one
 * transaction under a per-(server, file) advisory lock — `Admins.cfg` uses the
 * server-wide fence it shares with config-sync delivery — so concurrent
 * writers of a file are serialized and the DB tip always describes the bytes
 * on disk (#282). The insert precedes the disk write: a failed write rolls the
 * row back instead of leaving history that never reached the disk. The reload
 * runs after commit, outside the lock.
 *
 * When the content matches the DB tip no history row is inserted, but the file
 * on disk is still converged to the intended content: if it has drifted
 * out-of-band (e.g. hand-edited over SSH) — or `opts.force` is set — the write
 * is re-applied and the server reloaded, so "revert"-to-tip actually repairs
 * drift (CFG-2, #64). Such a response carries `unchanged: true` (no new
 * history) alongside `disk_repaired` and, when a write happened, the `reload`
 * outcome.
 *
 * `Rcon.cfg` (#10, #280): a masked `Password=` line is replaced with the
 * panel's password before the disk write, the stored history row carries the
 * masked rendering, and its `sha256` is the digest of the bytes on disk. The
 * resulting `Password=`/`Port=` must match `server_credentials`.
 *
 * Exported for reuse by the rotation editor (ROT-2, #145), which writes
 * `LayerRotation.cfg` through the same versioned-history pathway as the CFG-1
 * Monaco editor, and by the unban flow, which rewrites `Bans.cfg`.
 *
 * @throws {ConfigServerNotFoundError} 404 when the server is unknown or deleted.
 * @throws {RconPasswordUnavailableError} 422 when a masked `Rcon.cfg` has no
 *   real password to fill in.
 * @throws {RconCredentialsManagedError} 422 when an `Rcon.cfg` write would move
 *   `Password=` or `Port=` away from `server_credentials`.
 */
export async function writeVersion(
  app: FastifyInstance,
  serverId: string,
  name: AllowedConfigFile,
  content: string,
  message: string | null,
  authorPlayerId: string | null,
  authorIp: string | null,
  opts?: { force?: boolean },
) {
  // #10: `content` may carry the masked RCON password (editor round-trip or a
  // masked history row). The disk gets the real bytes and the sha describes
  // them (drift and dedup compare disk digests); the history row keeps only
  // the masked rendering. Resolved before the lock: it reads other rows.
  let diskContent = content;
  if (name === 'Rcon.cfg') {
    diskContent = await unmaskRconPassword(app, serverId, content);
    await assertRconCredentialsUnchanged(app, serverId, diskContent);
  }
  const persist = (tx: AdminsCfgSyncTransaction) =>
    persistVersion(app, tx, serverId, name, diskContent, message, authorPlayerId, authorIp, opts);
  const { response, wroteDisk } =
    name === 'Admins.cfg'
      ? await withAdminsCfgServerLock(app.db, serverId, persist)
      : await withConfigFileLock(app.db, serverId, name, persist);
  if (!wroteDisk) return response;

  // Push the change live, but only for hot-reload files
  // (Admins/Bans/RemoteAdmin/RemoteBan): those are the files Squad re-reads
  // from disk when AdminReloadServerConfig fires. `rotation` files apply on
  // the next match and `requires_restart` files need a container restart, so
  // firing RCON for them is misleading — the UI surfaces `not_hot_reload` and
  // (for requires_restart) offers a restart button instead (CFG-1, #63).
  // Best-effort: skip gracefully if the server isn't running or has no RCON
  // credentials yet, and surface the outcome so the UI can guide the operator.
  const reload: ReloadOutcome =
    configFileClass(name) === 'hot_reload'
      ? await reloadServerConfig(app, serverId)
      : { applied: false, reason: 'not_hot_reload' };
  return { ...response, reload };
}

async function persistVersion(
  app: FastifyInstance,
  db: Pick<DatabaseClient, 'select' | 'insert'>,
  serverId: string,
  name: AllowedConfigFile,
  diskContent: string,
  message: string | null,
  authorPlayerId: string | null,
  authorIp: string | null,
  opts?: { force?: boolean },
) {
  const live = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
    .limit(1);
  if (live.length === 0) throw new ConfigServerNotFoundError();

  // read previous for parent_version_id linkage (best-effort)
  const prev = await db
    .select({ id: configVersions.id, sha: configVersions.sha256 })
    .from(configVersions)
    .where(and(eq(configVersions.serverId, serverId), eq(configVersions.filename, name)))
    .orderBy(desc(configVersions.createdAt))
    .limit(1);
  const prevRow = prev[0];
  const newSha = sha256(diskContent);
  if (prevRow && Buffer.from(prevRow.sha as unknown as Buffer).equals(newSha)) {
    // History is unchanged, so we insert no new `config_versions` row. But the
    // file on disk may have drifted out-of-band (e.g. hand-edited over SSH)
    // while the DB tip stayed put. A "revert" to the tip must still converge
    // the disk back to the intended content — otherwise the drift silently
    // survives. Read the current on-disk bytes and repair only if they differ
    // (or the caller forces the write); treat a failing/absent read as "disk
    // unknown" and repair by writing, so a bridge read error never turns a
    // repair into a 500.
    let diskInSync = false;
    try {
      const onDisk = await app.bridge.fileRead({ path: configPath(serverId, name) });
      diskInSync = sha256(onDisk.content).equals(newSha);
    } catch {
      diskInSync = false;
    }
    const wroteDisk = Boolean(opts?.force) || !diskInSync;
    if (wroteDisk) {
      await app.bridge.fileAtomicWrite({ path: configPath(serverId, name), content: diskContent });
    }
    return {
      wroteDisk,
      response: {
        ok: true,
        unchanged: true,
        disk_repaired: !diskInSync,
        previous_sha256: hex(prevRow.sha as unknown as Buffer),
        sha256: hex(newSha),
        behavior: configFileClass(name),
      },
    };
  }
  const inserted = await db
    .insert(configVersions)
    .values({
      serverId,
      filename: name,
      content: maskConfigSecrets(name, diskContent),
      sha256: newSha,
      parentVersionId: prevRow?.id ?? null,
      authorPlayerId,
      authorLabel: authorPlayerId ? null : 'system',
      authorIp,
      message,
    })
    .returning({ id: configVersions.id, createdAt: configVersions.createdAt });
  await app.bridge.fileAtomicWrite({ path: configPath(serverId, name), content: diskContent });
  return {
    wroteDisk: true,
    response: {
      ok: true,
      unchanged: false,
      version_id: inserted[0]?.id,
      previous_sha256: prevRow ? hex(prevRow.sha as unknown as Buffer) : null,
      sha256: hex(newSha),
      created_at: inserted[0]?.createdAt,
      behavior: configFileClass(name),
    },
  };
}

export type ReloadOutcome =
  | {
      applied: true;
      via: 'rcon' | 'worker-rcon';
      command: string;
      response: string;
      request_id?: string;
    }
  | {
      applied: false;
      reason: 'not_running' | 'no_credentials' | 'rcon_failed' | 'not_hot_reload';
      detail?: string;
    };

/**
 * Exported so POST /restore can trigger the same push. Never throws — a
 * failing reload is not a failed write.
 */
export async function reloadServerConfig(
  app: FastifyInstance,
  serverId: string,
): Promise<ReloadOutcome> {
  const row = await app.db.query.servers.findFirst({
    where: and(eq(servers.id, serverId), isNull(servers.deletedAt)),
  });
  if (!row || (row.status !== 'running' && row.status !== 'starting')) {
    return { applied: false, reason: 'not_running', detail: row?.status ?? 'unknown' };
  }
  const command = 'AdminReloadServerConfig';
  const viaWorker = await sendRconCommandViaWorker(app.redis, {
    serverId,
    command,
    timeoutMs: 4000,
  });
  if (viaWorker.attempted) {
    if (viaWorker.ok) {
      return {
        applied: true,
        via: 'worker-rcon',
        command,
        response: viaWorker.response,
        request_id: viaWorker.requestId,
      };
    }
    return {
      applied: false,
      reason: 'rcon_failed',
      detail: viaWorker.detail ?? viaWorker.reason,
    };
  }
  const creds = await app.db.query.serverCredentials.findFirst({
    where: eq(serverCredentials.serverId, serverId),
  });
  if (!creds?.rconPasswordEncrypted) {
    return { applied: false, reason: 'no_credentials' };
  }
  try {
    const password = decryptString(
      app.encryptionKey,
      deserialize(Buffer.from(creds.rconPasswordEncrypted as unknown as Buffer)),
    );
    const response = await rconSendOnce({
      host: resolveRconHost(creds.rconHost),
      port: creds.rconPort,
      password,
      command,
      connectTimeoutMs: 2_000,
      commandTimeoutMs: 4_000,
    });
    return { applied: true, via: 'rcon', command, response };
  } catch (err) {
    return {
      applied: false,
      reason: 'rcon_failed',
      detail: (err as Error).message,
    };
  }
}

export default serverConfigRoutes;
