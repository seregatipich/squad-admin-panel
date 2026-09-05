import { servers } from '@squad/db/schema';
import type { ServerRuntime } from '@squad/shared-types';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Error body every container-bound route answers with (HTTP 409) when the
 * target server is hosted elsewhere. Kept in one place so the web client can
 * match a single `error` code.
 */
export const EXTERNAL_SERVER_ERROR = {
  error: 'external_server',
  message:
    'This server is hosted outside the panel (runtime=external); the operation applies only to panel-hosted containers.',
} as const;

export function isExternalRuntime(runtime: string | null | undefined): boolean {
  return runtime === 'external';
}

/**
 * Sends the 409 `external_server` answer. Returns the body so a handler can
 * `return rejectExternalServer(reply)`.
 */
export function rejectExternalServer(reply: FastifyReply): typeof EXTERNAL_SERVER_ERROR {
  reply.code(409);
  return EXTERNAL_SERVER_ERROR;
}

/**
 * Fastify `preHandler` that refuses container-only routes for external
 * servers before any bridge call is made. It looks at `params.id`; routes
 * without such a param, or with an id that is not an active server, fall
 * through untouched so the handler keeps its own 404/validation semantics.
 * Register it inside an encapsulated route plugin whose every `:id` is a
 * server id — Fastify scopes the hook to that plugin's routes.
 */
export function containerOnlyPreHandler(app: Pick<FastifyInstance, 'db'>) {
  return async function containerOnly(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const id = (req.params as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return;
    let runtime: string | undefined;
    try {
      const row = await app.db.query.servers.findFirst({
        where: and(eq(servers.id, id), isNull(servers.deletedAt)),
        columns: { runtime: true },
      });
      runtime = row?.runtime;
    } catch (err) {
      // The guard is a courtesy 409, not an authorization boundary: when the
      // lookup itself fails the handler runs and surfaces the real error on
      // its own path (and a WebSocket handshake is not turned into a 500).
      req.log.warn({ err: (err as Error).message, id }, 'runtime guard lookup failed');
      return;
    }
    if (isExternalRuntime(runtime as ServerRuntime)) {
      reply.code(409).send(EXTERNAL_SERVER_ERROR);
    }
  };
}
