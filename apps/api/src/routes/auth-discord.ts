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

const STATE_COOKIE = '__Host-discord-state';
const STATE_TTL_SECONDS = 300;
const STATE_REDIS_PREFIX = 'discord-oauth-state:';

const AUDIT_RESOURCE = 'player_discord_link';
const AUDIT_LINK = 'integration.discord.link';
const AUDIT_UNLINK = 'integration.discord.unlink';

const PG_UNIQUE_VIOLATION = '23505';

/** Drizzle wraps the driver error, so the SQLSTATE can sit one level down. */
function isUniqueViolation(err: unknown): boolean {
  return (
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION ||
    (err as { cause?: { code?: string } }).cause?.code === PG_UNIQUE_VIOLATION
  );
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
 * Rejects a caller without a session. `panel_access` is not checked
 * separately: `plugins/auth.ts` only ever populates `req.user` for a live
 * panel session, so holding one *is* the self-service entitlement the task
 * specifies for linking one's own Discord account.
 */
function requireSession(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return false;
  }
  return true;
}

/**
 * File-local hand-guard for the force-unlink route. The task gates removing
 * *someone else's* link on the `can_assign_roles` role flag rather than on a
 * catalogue permission key (`discord:link` stays `unimplemented`), and the
 * declarative `config.permissions` mechanism only understands catalogue keys.
 */
function panelGuard(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!requireSession(req, reply)) return false;
  if (!req.user?.permissions.canAssignRoles) {
    reply.code(403).send({ error: 'forbidden', required: 'can_assign_roles' });
    return false;
  }
  return true;
}

const discordAuthRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Step 1 of the link flow. A single-use random value lands in both Redis
   * (bound to the caller's player id, TTL 300 s) and
   * an httpOnly `__Host-` cookie, so the callback can prove the round-trip
   * started in this browser, for this session.
   */
  app.get(
    '/api/v1/auth/discord/login',
    { config: { audit: false, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!requireSession(req, reply)) return reply;
      const clientId = app.config.DISCORD_CLIENT_ID;
      if (!clientId || !app.config.DISCORD_CLIENT_SECRET) {
        return reply.code(503).send({ error: 'oauth_not_configured' });
      }

      const state = randomBytes(16).toString('base64url');
      await app.redis.set(
        `${STATE_REDIS_PREFIX}${state}`,
        JSON.stringify({ playerId: req.user?.playerId, ts: Date.now() }),
        'EX',
        STATE_TTL_SECONDS,
      );
      reply.setCookie(STATE_COOKIE, state, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
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
      reply.clearCookie(STATE_COOKIE, { path: '/' });

      if (!requireSession(req, reply)) return reply;
      const playerId = req.user?.playerId as string;

      const { code, state } = req.query;
      if (!code || !state || !cookieState || cookieState !== state) {
        return reply.code(403).send({ error: 'state_mismatch' });
      }

      const stored = await app.redis.get(`${STATE_REDIS_PREFIX}${state}`);
      if (!stored) {
        return reply.code(400).send({ error: 'state_expired' });
      }
      // Single-use: a replayed code can never reach the exchange twice.
      await app.redis.del(`${STATE_REDIS_PREFIX}${state}`);

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

      const existing = await app.db
        .select({ playerId: playerDiscordLinks.playerId })
        .from(playerDiscordLinks)
        .where(eq(playerDiscordLinks.playerId, playerId))
        .limit(1);
      if (existing[0]) {
        return reply.code(409).send({ error: 'already_linked_self' });
      }

      try {
        await app.db.insert(playerDiscordLinks).values({
          playerId,
          discordUserId,
          discordUsername,
        });
      } catch (err) {
        // 23505 here can only be the discord_user_id unique index: the
        // player's own row was just proven absent.
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: 'already_linked_other' });
        }
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
      if (!requireSession(req, reply)) return reply;
      const deleted = await app.db
        .delete(playerDiscordLinks)
        .where(eq(playerDiscordLinks.playerId, req.user?.playerId as string))
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
