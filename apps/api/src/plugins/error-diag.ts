import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const STACK_TRUNCATE_LIMIT = 2000;
const REASON_TRUNCATE_LIMIT = 2000;
const MESSAGE_TRUNCATE_LIMIT = 200;

let unhandledRejectionListenerAttached = false;

const MAX_CAUSE_CHAIN_DEPTH = 5;

/**
 * drizzle-orm wraps the driver error, so the postgres `23514` raised by the
 * `players_last_owner_guard` trigger can land on `err.cause` rather than on
 * the thrown object directly — walk the chain (see isUniqueViolation in
 * integrations-discord-role-mappings.ts for the same pattern).
 */
function isConstraintViolation(err: unknown, constraintName: string): boolean {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < MAX_CAUSE_CHAIN_DEPTH; depth++) {
    if (typeof current === 'object') {
      const candidate = current as { code?: unknown; constraint_name?: unknown };
      if (candidate.code === '23514' && candidate.constraint_name === constraintName) {
        return true;
      }
    }
    current = (current as { cause?: unknown } | null)?.cause;
  }
  return false;
}

export const errorDiagPlugin = fp(
  async (app: FastifyInstance) => {
    app.setErrorHandler((err: FastifyError, req, reply) => {
      if (isConstraintViolation(err, 'players_last_owner_guard')) {
        reply.code(409).send({ error: 'cannot_remove_last_owner' });
        return;
      }
      if (isConstraintViolation(err, 'players_vip_lifecycle_owner_guard')) {
        reply.code(409).send({ error: 'vip_lifecycle_required' });
        return;
      }
      if (isConstraintViolation(err, 'vip_lifecycle_catalog_guard')) {
        reply.code(409).send({ error: 'vip_lifecycle_owned' });
        return;
      }
      const replyStatus = reply.statusCode && reply.statusCode >= 400 ? reply.statusCode : 0;
      const status = replyStatus || err.statusCode || 500;
      if (status >= 500) {
        app.diag
          ?.emit({
            component: 'api',
            kind: 'http.5xx',
            severity: 'error',
            message: `${req.method} ${req.url} → ${err.message}`,
            requestId: req.id,
            actorPlayerId: req.user?.playerId,
            payload: {
              method: req.method,
              url: req.url,
              status,
              err: err.message,
              stack: err.stack?.slice(0, STACK_TRUNCATE_LIMIT),
            },
          })
          .catch(() => undefined);
      }
      reply.send(err);
    });

    if (!unhandledRejectionListenerAttached) {
      unhandledRejectionListenerAttached = true;
      process.on('unhandledRejection', (reason) => {
        const reasonStr = String(reason);
        app.diag
          ?.emit({
            component: 'api',
            kind: 'http.unhandled_rejection',
            severity: 'fatal',
            message: reasonStr.slice(0, MESSAGE_TRUNCATE_LIMIT),
            payload: { reason: reasonStr.slice(0, REASON_TRUNCATE_LIMIT) },
          })
          .catch(() => undefined);
      });
    }
  },
  { name: 'error-diag' },
);

export default errorDiagPlugin;
