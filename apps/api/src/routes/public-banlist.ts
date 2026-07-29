import { createHash } from 'node:crypto';
import { banlistPublicationSettings, moderationActions, players } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  type BanlistEntry,
  buildBanlistEntries,
  formatSquadBansCfg,
  type ModerationBanRow,
} from '../lib/banlist-publish.js';

const SINGLETON_ID = 1;
const RATE_LIMIT_MAX = 30;

const querystring = z.object({
  format: z.enum(['squad_cfg', 'json']).default('squad_cfg'),
});

interface BanRow {
  playerId: string;
  steamId64: bigint | null;
  eosId: string | null;
  nickname: string;
  reason: string | null;
  context: unknown;
  createdAt: Date;
  revertedAt: Date | null;
  authorName: string | null;
  authorSystemLabel: string | null;
}

function toModerationBanRow(row: BanRow): ModerationBanRow {
  const context = (row.context ?? {}) as { ban_length?: unknown };
  return {
    playerId: row.playerId,
    steamId64: row.steamId64 != null ? String(row.steamId64) : null,
    eosId: row.eosId,
    nickname: row.nickname,
    reason: row.reason,
    banLength: typeof context.ban_length === 'string' ? context.ban_length : null,
    issuedAt: row.createdAt,
    revertedAt: row.revertedAt,
    admin: row.authorName ?? row.authorSystemLabel,
  };
}

interface JsonBanEntry {
  steam_id64: string | null;
  eos_id: string | null;
  nickname: string | null;
  reason: string | null;
  issued_at: string;
  expires_at: string | null;
  admin: string | null;
}

function toJsonEntry(entry: BanlistEntry): JsonBanEntry {
  return {
    steam_id64: entry.steamId64,
    eos_id: entry.eosId,
    nickname: entry.nickname,
    reason: entry.reason,
    issued_at: entry.issuedAt.toISOString(),
    expires_at: entry.expiresAt ? entry.expiresAt.toISOString() : null,
    admin: entry.admin,
  };
}

function computeEtag(body: string): string {
  return `"${createHash('sha256').update(body).digest('hex')}"`;
}

/**
 * Outbound banlist federation (CBAN-5): read-only, API-token-gated endpoint
 * publishing this panel's active bans so another instance can subscribe to
 * it as an `external_ban_sources` entry (CBAN-1/CBAN-2, `format=squad_bans_cfg`
 * or `json_generic`). Never publishes IP addresses or admin notes — only
 * `steam_id64`/`eos_id`/`nickname`/`reason`/`issued_at`/`expires_at`/`admin`.
 * Gated on the `banlist:read` scope (a normal `PermissionKey`, grantable to a
 * role or intersected into an API token like any other scope) and the
 * `banlist_publication_settings` master switch; the publish scope
 * (`all_active` vs `permanent_only`) is also read from that singleton row.
 */
const publicBanlistRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const author = alias(players, 'banlist_author');

  fast.get(
    '/api/v1/public/banlist',
    {
      schema: {
        querystring,
        description:
          'Publishes this panel’s active bans for outbound federation (CBAN-5). ' +
          'Requires an API token (or session) with the `banlist:read` scope. ' +
          '`format=squad_cfg` returns `Banned:<SteamID64>:<unix-expiry> // <reason>` lines ' +
          'consumable by another instance’s ban-sync worker (`squad_bans_cfg`); ' +
          '`format=json` returns the same data with `eos_id`/`nickname`/`issued_at` included. ' +
          'Never includes IP addresses or admin notes. Supports `ETag`/`If-None-Match` caching.',
      },
      config: {
        audit: false,
        permissions: ['banlist:read'],
        rateLimit: { max: RATE_LIMIT_MAX, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.permissions.has('banlist:read')) {
        reply.code(403);
        return { error: 'forbidden', required: 'banlist:read' };
      }

      const settingsRows = await app.db
        .select()
        .from(banlistPublicationSettings)
        .where(eq(banlistPublicationSettings.id, SINGLETON_ID))
        .limit(1);
      const settings = settingsRows[0];
      if (!settings?.enabled) {
        reply.code(404);
        return { error: 'banlist_publication_disabled' };
      }
      const scope = settings.publishScope === 'permanent_only' ? 'permanent_only' : 'all_active';

      const rows = (await app.db
        .select({
          playerId: players.id,
          steamId64: players.steamId64,
          eosId: players.eosId,
          nickname: players.canonicalName,
          reason: moderationActions.reason,
          context: moderationActions.context,
          createdAt: moderationActions.createdAt,
          revertedAt: moderationActions.revertedAt,
          authorName: author.canonicalName,
          authorSystemLabel: moderationActions.authorSystemLabel,
        })
        .from(moderationActions)
        .innerJoin(players, eq(players.id, moderationActions.playerId))
        .leftJoin(author, eq(author.id, moderationActions.authorPlayerId))
        .where(
          and(eq(moderationActions.actionType, 'ban'), isNull(moderationActions.revertedAt)),
        )) as unknown as BanRow[];

      const banRows = rows.map(toModerationBanRow);
      const entries = buildBanlistEntries(banRows, scope, new Date());

      const lastModifiedMs =
        entries.length > 0 ? Math.max(...entries.map((entry) => entry.issuedAt.getTime())) : 0;
      const lastModified = new Date(lastModifiedMs).toUTCString();

      if (req.query.format === 'json') {
        const payload = {
          generated_at: new Date().toISOString(),
          bans: entries.map(toJsonEntry),
        };
        const body = JSON.stringify(payload);
        const etag = computeEtag(body);
        void reply.header('etag', etag);
        void reply.header('last-modified', lastModified);
        if (req.headers['if-none-match'] === etag) {
          reply.code(304);
          return null;
        }
        void reply.header('content-type', 'application/json; charset=utf-8');
        return body;
      }

      const body = formatSquadBansCfg(entries);
      const etag = computeEtag(body);
      void reply.header('etag', etag);
      void reply.header('last-modified', lastModified);
      if (req.headers['if-none-match'] === etag) {
        reply.code(304);
        return null;
      }
      void reply.header('content-type', 'text/plain; charset=utf-8');
      return body;
    },
  );
};

export default publicBanlistRoutes;
