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
            steamId64: players.steamId64,
            canonicalName: players.canonicalName,
          })
          .from(players)
          .where(eq(players.steamId64, session.steamId64))
          .limit(1);
        const player = playerRows[0];
        if (player) {
          req.session = { id: session.id, steamId64: player.steamId64 };
          req.user = {
            steamId64: player.steamId64,
            canonicalName: player.canonicalName,
            avatarUrl: null,
            permissions: await loadUserPermissions(app.db, player.steamId64),
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
            steamId64: playerApiTokens.steamId64,
            scopes: playerApiTokens.scopes,
          })
          .from(playerApiTokens)
          .where(and(eq(playerApiTokens.tokenHash, tokenHash), isNull(playerApiTokens.revokedAt)))
          .limit(1);
        const token = tokenRows[0];
        if (token) {
          const playerRows = await app.db
            .select({
              steamId64: players.steamId64,
              canonicalName: players.canonicalName,
            })
            .from(players)
            .where(eq(players.steamId64, token.steamId64))
            .limit(1);
          const player = playerRows[0];
          if (player) {
            const rolePerms = await loadUserPermissions(app.db, player.steamId64);
            const effective = intersectScopes(token.scopes, rolePerms.permissions);
            req.user = {
              steamId64: player.steamId64,
              canonicalName: player.canonicalName,
              avatarUrl: null,
              permissions: {
                permissions: effective,
                roleId: rolePerms.roleId,
              },
            };
            req.apiTokenId = token.id;
            await touchApiTokenLastUsed(app, token.id);
          }
        }
      }
    }

    const required = req.routeOptions?.config?.permissions;
    if (!required || required.length === 0) return;
    if (!req.user) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
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
