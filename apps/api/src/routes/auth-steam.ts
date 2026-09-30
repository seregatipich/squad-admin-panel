import { randomBytes } from 'node:crypto';
import { fetchSteamProfile } from '@squad/steam-api';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  establishAuthenticatedPlayerSession,
  type PlayerIdentity,
} from '../lib/authenticated-player.js';
import { buildLoginRedirectUrl, verifyWithSteam } from '../lib/steam-openid.js';
import { HOST_COOKIE_ATTRIBUTES } from '../plugins/auth.js';

const NONCE_COOKIE = '__Host-steam-nonce';
const NONCE_TTL_SECONDS = 300;
const NONCE_REDIS_PREFIX = 'steam-nonce:';
const RESPONSE_NONCE_REDIS_PREFIX = 'steam-response-nonce:';
const RESPONSE_NONCE_TTL_SECONDS = 3600;
/**
 * Profile enrichment on login is best-effort (a stub name is used on failure),
 * so a slow Steam Web API may delay the sign-in by at most this long (#53).
 */
const STEAM_LOGIN_PROFILE_TIMEOUT_MS = 3_000;

/**
 * Pages a Steam login may send the player back to (`?return_to=` on the login
 * route). An exact allow-list, never a prefix or URL check, so the login can
 * never become an open redirect. `/appeal` is the ban-appeal portal, which
 * needs a verified Steam identity to accept a submission (#40, finding #234).
 * Without an allow-listed value the callback keeps its default: `/` for a
 * panel session, `/me` for a self-service one.
 */
const STEAM_LOGIN_RETURN_PATHS: ReadonlySet<string> = new Set(['/appeal']);

/** Returns `value` when it is an allow-listed return path, otherwise undefined. */
function allowedReturnPath(value: unknown): string | undefined {
  return typeof value === 'string' && STEAM_LOGIN_RETURN_PATHS.has(value) ? value : undefined;
}

/**
 * Steam OpenID callback query (#96): our nonce `n` plus the provider's
 * `openid.*` fields. Every value must be a single string — a repeated key
 * (which the querystring parser turns into an array) is a 400 instead of
 * being dropped before signature verification. `n` stays optional so a
 * missing nonce still answers the specific `nonce_mismatch`.
 */
const callbackQuery = z
  .object({
    n: z.string().optional(),
    'openid.return_to': z.string().optional(),
  })
  .catchall(z.string());

const steamRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/api/v1/auth/steam/login',
    { config: { audit: false, public: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const nonce = randomBytes(16).toString('base64url');
      const returnTo = allowedReturnPath((req.query as { return_to?: unknown }).return_to);
      await app.redis.set(
        `${NONCE_REDIS_PREFIX}${nonce}`,
        JSON.stringify({ ts: Date.now(), ip: req.ip ?? null, ...(returnTo ? { returnTo } : {}) }),
        'EX',
        NONCE_TTL_SECONDS,
      );
      reply.setCookie(NONCE_COOKIE, nonce, {
        ...HOST_COOKIE_ATTRIBUTES,
        maxAge: NONCE_TTL_SECONDS,
      });
      const url = buildLoginRedirectUrl({
        panelPublicUrl: app.config.PANEL_PUBLIC_URL,
        nonce,
      });
      return reply.redirect(url, 302);
    },
  );

  fast.get(
    '/api/v1/auth/steam/callback',
    {
      schema: { querystring: callbackQuery },
      config: { audit: false, public: true, rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const q = req.query;
      const queryNonce = q.n;
      const cookieNonce = req.cookies[NONCE_COOKIE];
      reply.clearCookie(NONCE_COOKIE, HOST_COOKIE_ATTRIBUTES);

      if (!queryNonce || !cookieNonce || queryNonce !== cookieNonce) {
        return reply.code(400).send({ error: 'nonce_mismatch' });
      }

      const stored = await app.redis.getdel(`${NONCE_REDIS_PREFIX}${queryNonce}`);
      if (!stored) {
        return reply.code(400).send({ error: 'nonce_expired' });
      }
      let landingPath: string | undefined;
      try {
        landingPath = allowedReturnPath((JSON.parse(stored) as { returnTo?: unknown }).returnTo);
      } catch {
        landingPath = undefined;
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
          if (k.startsWith('openid.') && v !== undefined) params[k] = v;
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
          timeoutMs: STEAM_LOGIN_PROFILE_TIMEOUT_MS,
        });
        if (profile?.persona) canonicalName = profile.persona;
        if (profile?.avatarUrl) avatarUrl = profile.avatarUrl;
      } catch (err) {
        req.log.warn({ err }, 'steam profile enrichment failed (non-fatal)');
      }

      const identity: PlayerIdentity = { steamId64, canonicalName, avatarUrl };
      await establishAuthenticatedPlayerSession(app, req, reply, identity, {
        redirectTo: landingPath,
      });
      return reply;
    },
  );
};

export default steamRoutes;
