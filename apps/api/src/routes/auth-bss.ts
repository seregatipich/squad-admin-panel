import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { establishAuthenticatedPlayerSession } from '../lib/authenticated-player.js';
import { BssSsoClient, buildBssAuthorizeUrl } from '../lib/bss-sso.js';
import { revokeAllForPlayer } from '../lib/sessions.js';

const STATE_COOKIE = '__Host-bss-state';
const STATE_TTL_SECONDS = 300;
const STATE_RE = /^[A-Za-z0-9._~-]{32,512}$/u;
const CODE_RE = /^[A-Za-z0-9_-]{32,512}$/u;

const logoutRequestSchema = z
  .object({
    client_id: z.string().min(1).max(128),
    client_secret: z.string().min(1).max(512),
    steam_id64: z.string().regex(/^\d{17}$/u),
  })
  .strict();

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secureEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}

function configuredClient(app: Parameters<FastifyPluginAsync>[0]) {
  const siteUrl = app.config.BSS_SITE_URL;
  const clientId = app.config.BSS_SSO_CLIENT_ID;
  const clientSecret = app.config.BSS_SSO_CLIENT_SECRET;
  if (!siteUrl || !clientId || !clientSecret) return null;
  return {
    siteUrl,
    clientId,
    clientSecret,
    nextSecret: app.config.BSS_SSO_CLIENT_SECRET_NEXT ?? '',
    panelPublicUrl: app.config.PANEL_PUBLIC_URL,
  };
}

function safeCallbackLog(
  request: FastifyRequest,
  outcome: 'accepted' | 'rejected',
  errorClass: string | null,
): void {
  try {
    request.log.info(
      {
        event: 'bss.auth.callback',
        outcome,
        error_class: errorClass,
        client: 'bss',
        request_id: request.id,
      },
      'BSS authentication callback',
    );
  } catch {
    // Сбой при записи журнала не должен превратить готовый ответ в исключение,
    // автоматический текст которого раскроет параметры callback-запроса.
  }
}

const bssAuthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/v1/auth/bss/login',
    { config: { audit: false, public: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const config = configuredClient(app);
      if (!config) return reply.redirect('/login?error=sso_unavailable', 302);

      const state = randomBytes(32).toString('base64url');
      const codeVerifier = randomBytes(32).toString('base64url');
      await app.redis.set(`bss-state:${digest(state)}`, codeVerifier, 'EX', STATE_TTL_SECONDS);
      reply.setCookie(STATE_COOKIE, state, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: STATE_TTL_SECONDS,
      });
      return reply.redirect(
        buildBssAuthorizeUrl({
          siteUrl: config.siteUrl,
          panelPublicUrl: config.panelPublicUrl,
          clientId: config.clientId,
          state,
          codeVerifier,
        }),
        302,
      );
    },
  );

  app.get(
    '/api/v1/auth/bss/callback',
    { config: { audit: false, public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const code = typeof query.code === 'string' ? query.code : '';
      const state = typeof query.state === 'string' ? query.state : '';
      const cookieState = request.cookies[STATE_COOKIE] ?? '';
      reply.clearCookie(STATE_COOKIE, { path: '/' });

      if (
        !STATE_RE.test(state) ||
        !CODE_RE.test(code) ||
        !cookieState ||
        !secureEqual(state, cookieState)
      ) {
        safeCallbackLog(request, 'rejected', 'state_rejected');
        return reply.redirect('/login?error=sso_failed', 302);
      }

      try {
        const codeVerifier = await app.redis.getdel(`bss-state:${digest(state)}`);
        if (!codeVerifier) {
          safeCallbackLog(request, 'rejected', 'state_expired');
          return reply.redirect('/login?error=sso_failed', 302);
        }

        const config = configuredClient(app);
        if (!config) {
          safeCallbackLog(request, 'rejected', 'client_unavailable');
          return reply.redirect('/login?error=sso_failed', 302);
        }

        const identity = await new BssSsoClient(config).exchangeCode({ code, codeVerifier });
        const result = await establishAuthenticatedPlayerSession(app, request, reply, identity, {
          sendErrorResponse: false,
        });
        safeCallbackLog(
          request,
          result.ok ? 'accepted' : 'rejected',
          result.ok ? null : 'session_rejected',
        );
        return result.ok ? reply : reply.redirect('/login?error=sso_failed', 302);
      } catch {
        safeCallbackLog(request, 'rejected', 'exchange_failed');
        if (reply.sent) return reply;
        return reply.redirect('/login?error=sso_failed', 302);
      }
    },
  );

  app.post(
    '/api/v1/auth/bss/logout-all',
    {
      config: {
        audit: { action: 'auth.bss.logout_all', resource: 'session' },
        public: true,
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const parsed = logoutRequestSchema.safeParse(request.body);
      const config = configuredClient(app);
      if (!parsed.success || !config) return reply.code(400).send({ error: 'request_rejected' });

      const currentMatch = secureEqual(parsed.data.client_secret, config.clientSecret);
      const nextMatch = config.nextSecret
        ? secureEqual(parsed.data.client_secret, config.nextSecret)
        : false;
      if (!secureEqual(parsed.data.client_id, config.clientId) || (!currentMatch && !nextMatch)) {
        return reply.code(400).send({ error: 'request_rejected' });
      }

      const playerRows = await app.db
        .select({ id: players.id })
        .from(players)
        .where(eq(players.steamId64, BigInt(parsed.data.steam_id64)))
        .limit(1);
      const playerId = playerRows[0]?.id;
      if (playerId) {
        request.auditSnapshots = { targetId: playerId };
        await revokeAllForPlayer(app.db, app.redis, playerId, app.liveBus);
      }
      return { ok: true };
    },
  );
};

export default bssAuthRoutes;
