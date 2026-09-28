import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Shared panel-access guard for routes that gate on the `panel_access`
 * capability rather than on a single `config.permissions` key.
 *
 * Sets the reply status and returns the error body to send; returns `null`
 * when the caller may proceed. Callers use it as:
 *
 * ```ts
 * const denied = panelGuard(req, reply);
 * if (denied) return denied;
 * ```
 *
 * @param req - Request whose `req.user` was populated by the auth plugin.
 * @param reply - Reply whose status is set to 401 (no session) or 403
 *   (session without `panelAccess`) on denial.
 * @returns `{ error: 'unauthenticated' | 'forbidden' }` on denial, else `null`.
 */
export function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.panelAccess) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}
