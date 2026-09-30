import { playerApiTokens, players, sessions as sessionsTable } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  API_TOKEN_TOUCH_THROTTLE_SECONDS,
  extractBearerToken,
  hashApiToken,
  looksLikeApiToken,
} from '../lib/api-tokens.js';
import { loadUserPermissions, narrowToTokenScopes } from '../lib/rbac.js';
import { invalidateSessionCache, resolveSession, touchSession } from '../lib/sessions.js';

export const SESSION_COOKIE = '__Host-sid';

/**
 * Attributes every panel `__Host-` cookie is set AND cleared with.
 *
 * A browser only accepts a `__Host-`-prefixed cookie that is `Secure`, has
 * `Path=/` and no `Domain` (RFC 6265bis §4.1.3.2). That applies to the
 * expiring `Set-Cookie` a logout sends too: a deletion without `Secure` is
 * dropped whole, so the dead cookie would stay on the client (#1233). Pass
 * this object to `reply.clearCookie` and spread it into `reply.setCookie`.
 */
export const HOST_COOKIE_ATTRIBUTES = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
} as const;

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
              // The cached entry still carries the pre-touch deadline (#52).
              await invalidateSessionCache(app.redis, session.id);
            },
          });
          if (touched) {
            reply.setCookie(SESSION_COOKIE, cookieToken, {
              ...HOST_COOKIE_ATTRIBUTES,
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
          const rolePerms = player ? await loadUserPermissions(app.db, player.id) : null;
          // #7 — a token delegates its owner's *panel* access. Once the
          // owner's live role no longer grants `panel_access` (demotion,
          // expiry, removal) the token stops authenticating at all, instead
          // of reaching the routes that authorise on `req.user` alone. The
          // row is not revoked: restoring the role restores the token, the
          // "live intersect" rule in docs/architecture/decisions.md. Role
          // flags and Squad permissions are narrowed to the token's scopes
          // as well as the catalogue set — see `narrowToTokenScopes`.
          if (player && rolePerms?.panelAccess) {
            req.user = {
              playerId: player.id,
              steamId64: player.steamId64,
              canonicalName: player.canonicalName,
              avatarUrl: null,
              permissions: narrowToTokenScopes(rolePerms, token.scopes),
            };
            req.apiTokenId = token.id;
            await touchApiTokenLastUsed(app, token.id);
          }
        }
      }
    }

    // VIPSUB-5 (#171) — self-service session scope.
    //
    // `auth-steam.ts` mints a session for a player whose role has no
    // `panel_access` so they can manage their own VIP on `/me`. That session is
    // scoped `self_service` and is honoured ONLY on routes that opt in with
    // `config.selfService`; anywhere else the request is downgraded to
    // anonymous. Deny-by-default is required here rather than trusting the
    // permission set, because `loadUserPermissions` still honours explicit
    // `role_permissions` rows (flag-gated, #36), and because routes
    // authorise on `req.user` alone (`message-templates.ts`, …) or on
    // `squadPermissions`, which `rbac.ts` does not gate on `panel_access`.
    // Downgrading instead of answering 403 keeps genuinely public routes
    // public and leaks nothing about the caller.
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
  const ok = await app.redis.set(lockKey, '1', 'EX', API_TOKEN_TOUCH_THROTTLE_SECONDS, 'NX');
  if (ok !== 'OK') return;
  await app.db
    .update(playerApiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(playerApiTokens.id, tokenId));
}
