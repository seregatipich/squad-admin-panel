import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const STACK_TRUNCATE_LIMIT = 2000;
const REASON_TRUNCATE_LIMIT = 2000;
const MESSAGE_TRUNCATE_LIMIT = 200;

let unhandledRejectionListenerAttached = false;

export const errorDiagPlugin = fp(
  async (app: FastifyInstance) => {
    app.setErrorHandler((err: FastifyError, req, reply) => {
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
            actorSteamId64: req.user?.steamId64?.toString(),
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
