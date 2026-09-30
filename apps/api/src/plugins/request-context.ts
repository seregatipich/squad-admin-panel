import type { IncomingMessage } from 'node:http';
import fp from 'fastify-plugin';
import { v7 as uuidv7 } from 'uuid';
import { als } from '../lib/logger.js';

const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[\w-]+$/;

function isSafeRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

/**
 * Derives a request's correlation id from its `x-request-id` header: the
 * caller's id (cut to 128 characters) when it is made of word characters and
 * dashes, otherwise a fresh UUIDv7. Used as Fastify's `genReqId`, so `req.id`
 * — which routes, logs and queued events carry — never holds unvalidated
 * client input (#84).
 *
 * @param req - The raw incoming request.
 * @returns A request id safe to log, echo and enqueue.
 */
export function genRequestId(req: Pick<IncomingMessage, 'headers'>): string {
  const header = req.headers['x-request-id'];
  const candidate = typeof header === 'string' ? header.slice(0, MAX_REQUEST_ID_LENGTH) : '';
  return isSafeRequestId(candidate) ? candidate : uuidv7();
}

export default fp(async (app) => {
  app.addHook('onRequest', (req, reply, done) => {
    // Reuse `req.id` so the log `reqId`, `req.requestId` and the response
    // header are one id; derive it here only for an instance whose `genReqId`
    // produced something unsafe.
    const requestId = isSafeRequestId(req.id) ? req.id : genRequestId(req.raw);
    req.requestId = requestId;
    reply.header('x-request-id', requestId);
    als.run(
      {
        requestId,
        correlationId: requestId,
        userId: undefined,
        sessionId: undefined,
      },
      () => done(),
    );
  });
});
