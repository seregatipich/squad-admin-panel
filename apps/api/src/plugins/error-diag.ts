import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const STACK_TRUNCATE_LIMIT = 2000;
const REASON_TRUNCATE_LIMIT = 2000;
const MESSAGE_TRUNCATE_LIMIT = 200;
/** Longest wait for the fatal diag event before the process exits anyway. */
const FATAL_DIAG_TIMEOUT_MS = 2_000;

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

export interface ErrorDiagOptions {
  /**
   * Exit the process with code 1 after reporting an unhandled promise
   * rejection (default `true`). The test harness runs many app instances in
   * one process and passes `false`, leaving rejections to vitest.
   */
  exitOnUnhandledRejection?: boolean;
}

/**
 * Global error handler plus unhandled-rejection reporting.
 *
 * - A 5xx answers `{ statusCode, error: 'internal_error', requestId }`: the
 *   error message can carry SQL text and parameters (drizzle's
 *   `Failed query: … params: …`) or bridge internals, so it goes only to the
 *   `http.5xx` diag event. A 4xx keeps Fastify's envelope with its message.
 * - An unhandled rejection is reported as a `fatal` diag event and then ends
 *   the process with code 1, restoring Node's default crash so Docker's
 *   restart policy replaces an API left in an unknown state. Each app
 *   instance owns its listener and removes it on close.
 */
export const errorDiagPlugin = fp<ErrorDiagOptions>(
  async (app: FastifyInstance, opts) => {
    const exitOnUnhandledRejection = opts.exitOnUnhandledRejection ?? true;

    app.setErrorHandler((err: FastifyError, req, reply) => {
      if (isConstraintViolation(err, 'players_last_owner_guard')) {
        reply.code(409).send({ error: 'cannot_remove_last_owner' });
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
        reply.code(status).send({
          statusCode: status,
          error: 'internal_error',
          requestId: req.requestId ?? req.id,
        });
        return;
      }
      reply.send(err);
    });

    async function reportFatalRejection(reason: unknown): Promise<void> {
      const reasonStr = String(reason);
      app.log.fatal({ reason: reasonStr.slice(0, REASON_TRUNCATE_LIMIT) }, 'unhandled rejection');
      const emitted =
        app.diag
          ?.emit({
            component: 'api',
            kind: 'http.unhandled_rejection',
            severity: 'fatal',
            message: reasonStr.slice(0, MESSAGE_TRUNCATE_LIMIT),
            payload: { reason: reasonStr.slice(0, REASON_TRUNCATE_LIMIT) },
          })
          .catch(() => undefined) ?? Promise.resolve();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FATAL_DIAG_TIMEOUT_MS);
        timer.unref();
      });
      await Promise.race([emitted, timeout]);
      clearTimeout(timer);
      if (!exitOnUnhandledRejection) return;
      process.exitCode = 1;
      process.exit(1);
    }

    const onUnhandledRejection = (reason: unknown) => {
      void reportFatalRejection(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    app.addHook('onClose', async () => {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    });
  },
  { name: 'error-diag' },
);

export default errorDiagPlugin;
