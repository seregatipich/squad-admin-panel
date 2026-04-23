import fp from 'fastify-plugin';
import { v7 as uuidv7 } from 'uuid';
import { als } from '../lib/logger.js';

export default fp(async (app) => {
  app.addHook('onRequest', (req, reply, done) => {
    const headerId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 128);
    const requestId = headerId && /^[\w-]+$/.test(headerId) ? headerId : uuidv7();
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
