import { configVersions, players } from '@squad/db/schema';
import type { AllowedConfigFile } from '@squad/shared-config';
import { createPatch } from 'diff';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BLAME_MAX_VERSIONS, type BlameVersion, computeBlame } from '../../lib/blame.js';
import { maskConfigSecrets } from '../../lib/config-secrets.js';
import { canViewIps } from '../../lib/ip-visibility.js';
import {
  DIFF_TIMEOUT_MS,
  fileWriteForbidden,
  hex,
  isAllowed,
  nameParams,
  restoreBody,
} from '../../lib/server-configs/common.js';
import { writeVersion } from '../../lib/server-configs/write.js';

const versionParams = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  vid: z.string().uuid(),
});
const diffQuery = z.object({ from: z.string().uuid(), to: z.string().uuid() });

/** Config version history, single version, diff, blame and restore. */
const serverConfigHistoryRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

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
      const showIps = canViewIps(req);
      const items = rows.map((r) => ({
        id: r.id,
        sha256: hex(r.sha256),
        parent_version_id: r.parent_version_id,
        author_player_id: r.author_player_id ?? null,
        author_canonical_name: r.author_canonical_name ?? r.author_label ?? 'system',
        author_ip: showIps ? r.author_ip : null,
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
        sha256: hex(row.sha256),
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
              .where(inArray(players.id, playerIds))
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
};

export default serverConfigHistoryRoutes;
