import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { SESSION_COOKIE } from './auth.js';

/** Methods that must not change state, so a cross-site read needs no guard. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isWebSocketUpgrade(req: FastifyRequest): boolean {
  return String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Decides whether a cookie-authenticated request came from the panel itself.
 *
 * - An `Origin` header must be the panel's public origin, or name the same
 *   host the request was sent to (`Host`, which Caddy forwards unchanged), so
 *   a deployment reached under another name keeps working; `null` and every
 *   other origin — a sibling subdomain included — is refused.
 * - Without `Origin`, a browser's `Sec-Fetch-Site` must be `same-origin`
 *   (or `none`, a user-typed navigation).
 * - A request carrying neither header is not from a current browser (curl,
 *   the e2e client, server-side fetches) and cannot be a CSRF vector.
 */
function isSameOriginRequest(req: FastifyRequest, panelOrigin: string | null): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (panelOrigin !== null && origin === panelOrigin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined) return fetchSite === 'same-origin' || fetchSite === 'none';
  return true;
}

/**
 * Cross-site request guard (#66). `SameSite=Lax` on `__Host-sid` stops other
 * sites, but not a sibling subdomain of the same registrable domain, which is
 * "same-site": its forms and WebSocket handshakes would carry the session.
 * Every state-changing request and every WebSocket handshake that carries the
 * session cookie must therefore originate from the panel (see
 * {@link isSameOriginRequest}); others get `403 cross_site_request_forbidden`.
 * Requests without the cookie (API tokens, HMAC webhooks, public routes) are
 * untouched — they carry no ambient credential to abuse.
 */
export default fp(async (app) => {
  const panelOrigin = originOf(app.config.PANEL_PUBLIC_URL);
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method) && !isWebSocketUpgrade(req)) return;
    if (!req.cookies?.[SESSION_COOKIE]) return;
    if (isSameOriginRequest(req, panelOrigin)) return;
    req.log.warn(
      { origin: req.headers.origin, secFetchSite: req.headers['sec-fetch-site'], url: req.url },
      'cross-site request refused',
    );
    return reply.code(403).send({ error: 'cross_site_request_forbidden' });
  });
});
