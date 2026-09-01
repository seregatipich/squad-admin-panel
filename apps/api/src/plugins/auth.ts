import { playerApiTokens, players, sessions as sessionsTable } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  API_TOKEN_TOUCH_THROTTLE_SECONDS,
  extractBearerToken,
  hashApiToken,
  intersectScopes,
  looksLikeApiToken,
} from '../lib/api-tokens.js';
import { loadUserPermissions } from '../lib/rbac.js';
import { resolveSession, touchSession } from '../lib/sessions.js';

export const SESSION_COOKIE = '__Host-sid';

export default fp(async (app) => {
  const ttlSeconds = app.config.SESSION_TTL_SECONDS;
  const throttleSeconds = app.config.SESSION_TOUCH_THROTTLE_SECONDS;

  app.addHook('onRequest', async (req, reply) => {
    const cookieToken = req.cookies[SESSION_COOKIE];
    if (cookieToken) {
      const session = await resolveSession(app.db, app.redis, cookieToken);
      if (session) {
        const playerRows = await app.db
          .select({
            id: players.id,
            steamId64: players.steamId64,
            canonicalName: players.canonicalName,
          })
          .from(players)
          .where(eq(players.id, session.playerId))
          .limit(1);
        const player = playerRows[0];
        if (player) {
          req.session = { id: session.id, playerId: player.id, scope: session.scope };
          req.user = {
            playerId: player.id,
            steamId64: player.steamId64,
            canonicalName: player.canonicalName,
            avatarUrl: null,
            permissions: await loadUserPermissions(app.db, player.id),
          };
          const touched = await touchSession({
            sessionId: session.id,
            redis: app.redis,
            now: new Date(),
            ttlSeconds,
            throttleSeconds,
            updateDb: async (expiresAt, lastActivity) => {
              await app.db
                .update(sessionsTable)
                .set({ expiresAt, lastActivityAt: lastActivity })
                .where(eq(sessionsTable.id, session.id));
            },
          });
          if (touched) {
            reply.setCookie(SESSION_COOKIE, cookieToken, {
              path: '/',
              httpOnly: true,
              secure: true,
              sameSite: 'lax',
              maxAge: ttlSeconds,
            });
          }
        }
      }
    } else {
      const bearer = extractBearerToken(req.headers.authorization);
      if (bearer && looksLikeApiToken(bearer)) {
        const tokenHash = hashApiToken(bearer);
        const tokenRows = await app.db
          .select({
            id: playerApiTokens.id,
            playerId: playerApiTokens.playerId,
            scopes: playerApiTokens.scopes,
          })
          .from(playerApiTokens)
          .where(and(eq(playerApiTokens.tokenHash, tokenHash), isNull(playerApiTokens.revokedAt)))
          .limit(1);
        const token = tokenRows[0];
        if (token) {
          const playerRows = await app.db
            .select({
              id: players.id,
              steamId64: players.steamId64,
              canonicalName: players.canonicalName,
            })
            .from(players)
            .where(eq(players.id, token.playerId))
            .limit(1);
          const player = playerRows[0];
          if (player) {
            const rolePerms = await loadUserPermissions(app.db, player.id);
            const effective = intersectScopes(token.scopes, rolePerms.permissions);
            req.user = {
              playerId: player.id,
              steamId64: player.steamId64,
              canonicalName: player.canonicalName,
              avatarUrl: null,
              permissions: {
                ...rolePerms,
                permissions: effective,
              },
            };
            req.apiTokenId = token.id;
            await touchApiTokenLastUsed(app, token.id);
          }
        }
      }
    }

    // VIPSUB-5 (#171) — self-service session scope.
    //
    // The BSS callback mints a session for a player whose role has no
    // `panel_access` so they can manage their own VIP on `/me`. That session is
    // scoped `self_service` and is honoured ONLY on routes that opt in with
    // `config.selfService`; anywhere else the request is downgraded to
    // anonymous. Deny-by-default is required here rather than trusting the
    // permission set, because `loadUserPermissions` adds explicit
    // `role_permissions` rows on top of the derived set, and because ~30 routes
    // authorise on `req.user` alone (`issues.ts`, `message-templates.ts`,
    // `banned-names.ts`) or on `squadPermissions`, which `rbac.ts` does not gate
    // on `panel_access`. Downgrading instead of answering 403 keeps genuinely
    // public routes public and leaks nothing about the caller.
    //
    // The scope never over-restricts a real admin: once the player actually
    // holds `panel_access` the gate lifts without re-login.
    if (
      req.session?.scope === 'self_service' &&
      !req.user?.permissions.panelAccess &&
      req.routeOptions?.config?.selfService !== true
    ) {
      req.user = undefined;
      req.session = undefined;
      req.apiTokenId = undefined;
    }

    // #246 — fail-closed default. A route is authenticated-required unless it
    // explicitly opts out with `config.public: true`; declaring
    // `config.permissions` further narrows it to specific permission holders.
    // Before this hook was inverted, a route with neither `public` nor
    // `permissions` was silently served to anonymous callers (`/api/docs*`,
    // `GET /api/v1/host/bridge-status`, and others) — see #230 for the audit.
    if (req.routeOptions?.config?.public === true) return;
    if (!req.user) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    const required = req.routeOptions?.config?.permissions ?? [];
    for (const perm of required) {
      if (!req.user.permissions.permissions.has(perm)) {
        reply.code(403).send({ error: 'forbidden', required });
        return;
      }
    }
  });
});

async function touchApiTokenLastUsed(app: FastifyInstance, tokenId: string): Promise<void> {
  const lockKey = `api-token-touch:${tokenId}`;
  const ok = await app.redis.set(
    lockKey,
    '1',
    'EX' as never,
    API_TOKEN_TOUCH_THROTTLE_SECONDS as never,
    'NX' as never,
  );
  if (ok !== 'OK') return;
  await app.db
    .update(playerApiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(playerApiTokens.id, tokenId));
}
