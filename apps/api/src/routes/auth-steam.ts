import { randomBytes } from 'node:crypto';
import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { claimFirstOwner } from '../lib/first-owner.js';
import { loadUserPermissions } from '../lib/rbac.js';
import { createSession } from '../lib/sessions.js';
import { buildLoginRedirectUrl, verifyWithSteam } from '../lib/steam-openid.js';
import { fetchSteamProfile } from '../lib/steam-profile.js';
import { SESSION_COOKIE } from '../plugins/auth.js';

const NONCE_COOKIE = '__Host-steam-nonce';
const NONCE_TTL_SECONDS = 300;
const NONCE_REDIS_PREFIX = 'steam-nonce:';
const RESPONSE_NONCE_REDIS_PREFIX = 'steam-response-nonce:';
const RESPONSE_NONCE_TTL_SECONDS = 3600;

const steamRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/auth/steam/login',
    { config: { audit: false, public: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const nonce = randomBytes(16).toString('base64url');
      await app.redis.set(
        `${NONCE_REDIS_PREFIX}${nonce}`,
        JSON.stringify({ ts: Date.now(), ip: req.ip ?? null }),
        'EX',
        NONCE_TTL_SECONDS,
      );
      reply.setCookie(NONCE_COOKIE, nonce, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: NONCE_TTL_SECONDS,
      });
      const url = buildLoginRedirectUrl({
        panelPublicUrl: app.config.PANEL_PUBLIC_URL,
        nonce,
      });
      return reply.redirect(url, 302);
    },
  );

  app.get(
    '/api/v1/auth/steam/callback',
    { config: { audit: false, public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const queryNonce = q.n;
      const cookieNonce = req.cookies[NONCE_COOKIE];
      reply.clearCookie(NONCE_COOKIE, { path: '/' });

      if (!queryNonce || !cookieNonce || queryNonce !== cookieNonce) {
        return reply.code(400).send({ error: 'nonce_mismatch' });
      }

      const stored = await app.redis.get(`${NONCE_REDIS_PREFIX}${queryNonce}`);
      await app.redis.del(`${NONCE_REDIS_PREFIX}${queryNonce}`);
      if (!stored) {
        return reply.code(400).send({ error: 'nonce_expired' });
      }

      const expectedReturnPrefix = `${app.config.PANEL_PUBLIC_URL.replace(/\/+$/, '')}/api/v1/auth/steam/callback`;
      const returnTo = q['openid.return_to'];
      if (!returnTo || !returnTo.startsWith(expectedReturnPrefix)) {
        return reply.code(400).send({ error: 'return_to_mismatch' });
      }

      let steamId64: bigint;
      let responseNonce: string;
      try {
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(q)) {
          if (k.startsWith('openid.') && typeof v === 'string') params[k] = v;
        }
        const verified = await verifyWithSteam(params);
        steamId64 = verified.steamId64;
        responseNonce = verified.responseNonce;
      } catch (err) {
        req.log.warn({ err }, 'steam verification failed');
        return reply.redirect('/login?error=auth_failed', 302);
      }

      const setNonceOk = await app.redis.set(
        `${RESPONSE_NONCE_REDIS_PREFIX}${responseNonce}`,
        '1',
        'EX',
        RESPONSE_NONCE_TTL_SECONDS,
        'NX',
      );
      if (setNonceOk !== 'OK') {
        return reply.code(400).send({ error: 'replay_detected' });
      }

      let canonicalName = `Player ${String(steamId64).slice(-4)}`;
      try {
        const profile = await fetchSteamProfile(steamId64, {
          apiKey: app.config.STEAM_API_KEY ?? '',
          redis: app.redis,
        });
        if (profile?.persona) canonicalName = profile.persona;
      } catch (err) {
        req.log.warn({ err }, 'steam profile enrichment failed (non-fatal)');
      }

      const existing = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.steamId64, steamId64))
        .limit(1);

      let playerId: string;
      if (existing[0]) {
        playerId = existing[0].id;
        await app.db
          .update(players)
          .set({
            canonicalName,
            canonicalNameNormalized: canonicalName.toLowerCase(),
            updatedAt: new Date(),
          })
          .where(eq(players.id, playerId));
      } else {
        playerId = uuidv7();
        await app.db.insert(players).values({
          id: playerId,
          steamId64,
          canonicalName,
          canonicalNameNormalized: canonicalName.toLowerCase(),
        });
      }

      // biome-ignore lint/suspicious/noExplicitAny: SentinelBridge structural subtype
      const claim = await claimFirstOwner(app.db, app.bridge as any, playerId, steamId64);
      if (claim === 'no_owner_role') {
        req.log.error('Owner role missing — system roles not seeded?');
        return reply.code(500).send({ error: 'owner_role_missing' });
      }

      // VIPSUB-5 (#171): a player without `panel_access` used to be refused a
      // session outright and bounced to `/no-access`. Self-service VIP needs
      // them authenticated, so they now get a `self_service`-scoped session and
      // land on `/me`. That scope is honoured only on routes declaring
      // `config.selfService` (`apps/api/src/plugins/auth.ts`), so the panel is
      // exactly as unreachable for them as it was before.
      const ctx = await loadUserPermissions(app.db, playerId);
      const scope = ctx.panelAccess ? 'panel' : 'self_service';

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
    },
  );
};

export default steamRoutes;
