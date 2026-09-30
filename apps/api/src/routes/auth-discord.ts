import { randomBytes } from 'node:crypto';
import { playerDiscordLinks } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { writeAuditEntry } from '../lib/audit.js';
import {
  buildAuthorizeUrl,
  buildRedirectUri,
  displayNameFor,
  exchangeCode,
  fetchDiscordUser,
} from '../lib/discord-oauth.js';
import { isUniqueViolation } from '../lib/pg-errors.js';
import { requestUser } from '../lib/request-user.js';
import { HOST_COOKIE_ATTRIBUTES } from '../plugins/auth.js';

const STATE_COOKIE = '__Host-discord-state';
const STATE_TTL_SECONDS = 300;
const STATE_REDIS_PREFIX = 'discord-oauth-state:';

const AUDIT_RESOURCE = 'player_discord_link';
const AUDIT_LINK = 'integration.discord.link';
const AUDIT_UNLINK = 'integration.discord.unlink';

const DISCORD_USER_ID_UNIQUE = 'player_discord_links_discord_user_id_unique';

/**
 * Maps a unique violation on `player_discord_links` to the conflict it
 * reports (#95). The table has two unique constraints: the `player_id`
 * primary key (the caller already has a link — also what two concurrent
 * callbacks of one player race into) and `discord_user_id` (the Discord
 * account belongs to another player).
 *
 * @returns the 409 error code, or null when `err` is not a unique violation.
 */
function linkConflict(err: unknown): 'already_linked_self' | 'already_linked_other' | null {
  if (!isUniqueViolation(err)) return null;
  return isUniqueViolation(err, DISCORD_USER_ID_UNIQUE)
    ? 'already_linked_other'
    : 'already_linked_self';
}

const playerIdParams = z.object({ playerId: z.string().uuid() });
const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
});

const linkResponse = z.object({
  linked: z.boolean(),
  discord_user_id: z.string().nullable(),
  discord_username: z.string().nullable(),
  linked_at: z.string().nullable(),
});

/**
 * File-local hand-guard for the force-unlink route. The task gates removing
 * *someone else's* link on the `can_assign_roles` role flag rather than on a
 * catalogue permission key (`discord:link` stays `unimplemented`), and the
 * declarative `config.permissions` mechanism only understands catalogue keys.
 */
function panelGuard(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!requestUser(req).permissions.canAssignRoles) {
    reply.code(403).send({ error: 'forbidden', required: 'can_assign_roles' });
    return false;
  }
  return true;
}

const discordAuthRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Step 1 of the link flow. Mirrors `auth-steam.ts`: a single-use random
   * value lands in both Redis (bound to the caller's player id, TTL 300 s) and
   * an httpOnly `__Host-` cookie, so the callback can prove the round-trip
   * started in this browser, for this session.
   */
  app.get(
    '/api/v1/auth/discord/login',
    { config: { audit: false, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { playerId } = requestUser(req);
      const clientId = app.config.DISCORD_CLIENT_ID;
      if (!clientId || !app.config.DISCORD_CLIENT_SECRET) {
        return reply.code(503).send({ error: 'oauth_not_configured' });
      }

      const state = randomBytes(16).toString('base64url');
      await app.redis.set(
        `${STATE_REDIS_PREFIX}${state}`,
        JSON.stringify({ playerId, ts: Date.now() }),
        'EX',
        STATE_TTL_SECONDS,
      );
      reply.setCookie(STATE_COOKIE, state, {
        ...HOST_COOKIE_ATTRIBUTES,
        maxAge: STATE_TTL_SECONDS,
      });

      return reply.redirect(
        buildAuthorizeUrl({
          clientId,
          redirectUri: buildRedirectUri(app.config.PANEL_PUBLIC_URL),
          state,
        }),
        302,
      );
    },
  );

  /**
   * Step 2. Audit is written by hand (`config.audit: false`) so only a
   * *successful* link produces an `integration.discord.link` row — the
   * declarative hook would also record every rejected CSRF probe. A GET is not
   * a mutating route for `audit-coverage.test.ts`, so the two-URL allowlist
   * there is untouched.
   */
  fast.get(
    '/api/v1/auth/discord/callback',
    {
      schema: { querystring: callbackQuery },
      config: { audit: false, rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const cookieState = req.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, HOST_COOKIE_ATTRIBUTES);

      const { playerId } = requestUser(req);

      const { code, state } = req.query;
      if (!code || !state || !cookieState || cookieState !== state) {
        return reply.code(403).send({ error: 'state_mismatch' });
      }

      // Single-use, atomically (#95): GETDEL hands the record to exactly one
      // of any concurrent callbacks, so a replayed state never reaches the
      // exchange twice.
      const stored = await app.redis.getdel(`${STATE_REDIS_PREFIX}${state}`);
      if (!stored) {
        return reply.code(400).send({ error: 'state_expired' });
      }

      let statePlayerId: string | null = null;
      try {
        statePlayerId = (JSON.parse(stored) as { playerId?: string }).playerId ?? null;
      } catch {
        statePlayerId = null;
      }
      if (statePlayerId !== playerId) {
        return reply.code(403).send({ error: 'state_mismatch' });
      }

      if (!app.config.DISCORD_CLIENT_ID || !app.config.DISCORD_CLIENT_SECRET) {
        return reply.code(503).send({ error: 'oauth_not_configured' });
      }

      let discordUserId: string;
      let discordUsername: string;
      try {
        const accessToken = await exchangeCode(code, {
          clientId: app.config.DISCORD_CLIENT_ID,
          clientSecret: app.config.DISCORD_CLIENT_SECRET,
          redirectUri: buildRedirectUri(app.config.PANEL_PUBLIC_URL),
        });
        if (!accessToken) {
          return reply.code(503).send({ error: 'oauth_not_configured' });
        }
        const user = await fetchDiscordUser(accessToken);
        discordUserId = user.id;
        discordUsername = displayNameFor(user);
      } catch (err) {
        req.log.warn({ err }, 'discord oauth exchange failed');
        return reply.code(502).send({ error: 'discord_exchange_failed' });
      }

      try {
        await app.db.insert(playerDiscordLinks).values({
          playerId,
          discordUserId,
          discordUsername,
        });
      } catch (err) {
        const conflict = linkConflict(err);
        if (conflict) return reply.code(409).send({ error: conflict });
        throw err;
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: AUDIT_LINK,
        targetType: AUDIT_RESOURCE,
        targetId: playerId,
        after: { discord_username: discordUsername },
        context: {
          requestId: req.id,
          method: req.method,
          url: req.url,
          userAgent: req.headers['user-agent'] ?? null,
        },
        statusCode: 302,
      });

      return reply.redirect(`/players/${playerId}`, 302);
    },
  );

  /** Self-service unlink — available to any session, on the caller's own link. */
  app.delete(
    '/api/v1/players/me/discord/link',
    { config: { audit: { action: AUDIT_UNLINK, resource: AUDIT_RESOURCE } } },
    async (req, reply) => {
      const deleted = await app.db
        .delete(playerDiscordLinks)
        .where(eq(playerDiscordLinks.playerId, requestUser(req).playerId))
        .returning({ playerId: playerDiscordLinks.playerId });
      if (deleted.length === 0) {
        return reply.code(404).send({ error: 'not_linked' });
      }
      return { ok: true };
    },
  );

  /** Forced unlink of somebody else's link — `can_assign_roles` only. */
  fast.delete(
    '/api/v1/players/:playerId/discord/link',
    {
      schema: { params: playerIdParams },
      config: { audit: { action: AUDIT_UNLINK, resource: AUDIT_RESOURCE } },
    },
    async (req, reply) => {
      if (!panelGuard(req, reply)) return reply;
      const deleted = await app.db
        .delete(playerDiscordLinks)
        .where(eq(playerDiscordLinks.playerId, req.params.playerId))
        .returning({ playerId: playerDiscordLinks.playerId });
      if (deleted.length === 0) {
        return reply.code(404).send({ error: 'not_linked' });
      }
      return { ok: true };
    },
  );

  /**
   * Read model for the player-card section. `discord_user_id` is served here
   * — behind `player:view` — and nowhere else; no `public-*` route may select
   * this table.
   */
  fast.get(
    '/api/v1/players/:playerId/discord',
    {
      schema: { params: playerIdParams, response: { 200: linkResponse } },
      config: { permissions: ['player:view'], audit: false },
    },
    async (req) => {
      const [row] = await app.db
        .select({
          discordUserId: playerDiscordLinks.discordUserId,
          discordUsername: playerDiscordLinks.discordUsername,
          linkedAt: playerDiscordLinks.linkedAt,
        })
        .from(playerDiscordLinks)
        .where(eq(playerDiscordLinks.playerId, req.params.playerId))
        .limit(1);

      if (!row) {
        return {
          linked: false,
          discord_user_id: null,
          discord_username: null,
          linked_at: null,
        };
      }
      return {
        linked: true,
        discord_user_id: row.discordUserId,
        discord_username: row.discordUsername,
        linked_at: row.linkedAt.toISOString(),
      };
    },
  );
};

export default discordAuthRoutes;
