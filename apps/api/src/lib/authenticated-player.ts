import { players } from '@squad/db/schema';
import { normalizePlayerName } from '@squad/shared-config';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '../plugins/auth.js';
import type { BssIdentity } from './bss-sso.js';
import { claimFirstOwner } from './first-owner.js';
import { loadUserPermissions } from './rbac.js';
import { createSession } from './sessions.js';

export async function establishAuthenticatedPlayerSession(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  identity: BssIdentity,
): Promise<FastifyReply> {
  const canonicalName = identity.canonicalName.trim();
  const canonicalNameNormalized = normalizePlayerName(canonicalName);
  if (!canonicalName || !canonicalNameNormalized) {
    return reply.code(400).send({ error: 'identity_rejected' });
  }

  const update = {
    canonicalName,
    canonicalNameNormalized,
    updatedAt: new Date(),
    ...(identity.avatarUrl === null ? {} : { avatarUrl: identity.avatarUrl }),
  };
  const playerRows = await app.db
    .insert(players)
    .values({
      steamId64: identity.steamId64,
      canonicalName,
      canonicalNameNormalized,
      avatarUrl: identity.avatarUrl,
    })
    .onConflictDoUpdate({ target: players.steamId64, set: update })
    .returning({ id: players.id });
  const playerId = playerRows[0]?.id;
  if (!playerId) return reply.code(500).send({ error: 'identity_persist_failed' });

  // biome-ignore lint/suspicious/noExplicitAny: SentinelBridge structural subtype
  const claim = await claimFirstOwner(app.db, app.bridge as any, playerId, identity.steamId64);
  if (claim === 'no_owner_role') {
    req.log.error('Owner role missing — system roles not seeded?');
    return reply.code(500).send({ error: 'owner_role_missing' });
  }

  const permissions = await loadUserPermissions(app.db, playerId);
  const scope = permissions.panelAccess ? 'panel' : 'self_service';
  const { token } = await createSession(app.db, app.redis, {
    playerId,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    ttlMs: app.config.SESSION_TTL_SECONDS * 1000,
    scope,
  });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: app.config.SESSION_TTL_SECONDS,
  });
  return reply.redirect(scope === 'panel' ? '/' : '/me', 302);
}
