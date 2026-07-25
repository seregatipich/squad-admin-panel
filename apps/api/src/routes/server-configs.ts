import { createHash } from 'node:crypto';
import { configVersions, players, serverCredentials, servers } from '@squad/db/schema';
import {
  ALLOWED_CONFIG_FILES,
  type AllowedConfigFile,
  configFileClass,
  PANEL_CONFIGS_ROOT,
} from '@squad/shared-config';
import { createPatch } from 'diff';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type BlameVersion, computeBlame } from '../lib/blame.js';
import { decryptString, deserialize } from '../lib/crypto.js';
import { resolveRconHost } from '../lib/rcon-host.js';
import { rconSendOnce } from '../lib/rcon-send.js';
import { sendRconCommandViaWorker } from '../lib/rcon-worker-command.js';

const idParams = z.object({ id: z.string().uuid() });
const nameParams = z.object({ id: z.string().uuid(), name: z.string().min(1).max(64) });
const versionParams = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  vid: z.string().uuid(),
});
const diffQuery = z.object({ from: z.string().uuid(), to: z.string().uuid() });
const bodySchema = z.object({
  content: z.string().max(1024 * 1024),
  message: z.string().max(500).optional(),
});
const restoreBody = z
  .object({ message: z.string().max(500).optional() })
  .default({ message: undefined });

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
      try {
        const { content } = await app.bridge.fileRead({
          path: configPath(req.params.id, req.params.name),
        });
        return {
          name: req.params.name,
          content,
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
          size: configVersions.content,
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
        size: Buffer.byteLength(r.size ?? '', 'utf-8'),
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
      return {
        id: row.id,
        content: row.content,
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
        .select({
          id: configVersions.id,
          content: configVersions.content,
          created_at: configVersions.createdAt,
        })
        .from(configVersions)
        .where(
          and(
            eq(configVersions.serverId, req.params.id),
            eq(configVersions.filename, req.params.name),
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
        fromRow.content,
        toRow.content,
        fromRow.id.slice(0, 8),
        toRow.id.slice(0, 8),
      );
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
        .orderBy(desc(configVersions.createdAt))
        .limit(1);
      if (tip.length === 0) {
        return { lines: [], authors: {} };
      }
      const tipId = tip[0]?.id;
      const cacheKey = `config-blame:${tipId}`;
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
        );
      const vs: BlameVersion[] = rows.map((r) => ({
        id: r.id,
        content: r.content,
        author_player_id: r.author_player_id ?? null,
        author_label: r.author_label,
        created_at: (r.created_at as Date).toISOString(),
      }));
      const lines = computeBlame(vs);
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
      const payload = { lines, authors };
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
};

import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

function inArrayOr<T>(col: Parameters<typeof inArray>[0], values: T[]) {
  if (values.length === 0) throw new Error('empty values');
  return inArray(col, values as Parameters<typeof inArray>[1]);
}

/**
 * Writes a new config version: dedups against the current tip by sha256
 * (no-op if unchanged), otherwise persists via `bridge.fileAtomicWrite`,
 * inserts a `config_versions` row, and best-effort pushes the change live
 * via `AdminReloadServerConfig`. Exported for reuse by the rotation editor
 * (ROT-2, #145), which writes `LayerRotation.cfg` through the same
 * versioned-history pathway as the CFG-1 Monaco editor.
 */
export async function writeVersion(
  app: FastifyInstance,
  serverId: string,
  name: AllowedConfigFile,
  content: string,
  message: string | null,
  authorPlayerId: string | null,
  authorIp: string | null,
) {
  // read previous for parent_version_id linkage (best-effort)
  const prev = await app.db
    .select({ id: configVersions.id, sha: configVersions.sha256 })
    .from(configVersions)
    .where(and(eq(configVersions.serverId, serverId), eq(configVersions.filename, name)))
    .orderBy(desc(configVersions.createdAt))
    .limit(1);
  const prevRow = prev[0];
  const newSha = sha256(content);
  if (prevRow && Buffer.from(prevRow.sha as unknown as Buffer).equals(newSha)) {
    // no-op write; don't pollute history
    return {
      ok: true,
      unchanged: true,
      previous_sha256: hex(prevRow.sha as unknown as Buffer),
      sha256: hex(newSha),
      behavior: configFileClass(name),
    };
  }
  await app.bridge.fileAtomicWrite({ path: configPath(serverId, name), content });
  const inserted = await app.db
    .insert(configVersions)
    .values({
      serverId,
      filename: name,
      content,
      sha256: newSha,
      parentVersionId: prevRow?.id ?? null,
      authorPlayerId,
      authorLabel: authorPlayerId ? null : 'system',
      authorIp,
      message,
    })
    .returning({ id: configVersions.id, createdAt: configVersions.createdAt });

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
  return {
    ok: true,
    unchanged: false,
    version_id: inserted[0]?.id,
    previous_sha256: prevRow ? hex(prevRow.sha as unknown as Buffer) : null,
    sha256: hex(newSha),
    created_at: inserted[0]?.createdAt,
    behavior: configFileClass(name),
    reload,
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
