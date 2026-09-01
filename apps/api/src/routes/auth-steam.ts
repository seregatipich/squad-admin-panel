import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { establishAuthenticatedPlayerSession } from '../lib/authenticated-player.js';
import type { BssIdentity } from '../lib/bss-sso.js';
import { buildLoginRedirectUrl, verifyWithSteam } from '../lib/steam-openid.js';
import { fetchSteamProfile } from '../lib/steam-profile.js';

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
      let avatarUrl: string | null = null;
      try {
        const profile = await fetchSteamProfile(steamId64, {
          apiKey: app.config.STEAM_API_KEY ?? '',
          redis: app.redis,
        });
        if (profile?.persona) canonicalName = profile.persona;
        if (profile?.avatarUrl) avatarUrl = profile.avatarUrl;
      } catch (err) {
        req.log.warn({ err }, 'steam profile enrichment failed (non-fatal)');
      }

      const identity: BssIdentity = { steamId64, canonicalName, avatarUrl };
      await establishAuthenticatedPlayerSession(app, req, reply, identity);
      return reply;
    },
  );
};

export default steamRoutes;
