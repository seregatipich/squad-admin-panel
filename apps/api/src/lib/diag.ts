import { createDiag, type Diag } from '@squad/diag';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    diag: Diag;
  }
  interface FastifyRequest {
    diag: Diag;
  }
}

export default fp(async (app) => {
  const diag = createDiag({ redis: app.redis, log: app.log });
  app.decorate('diag', diag);
  app.decorateRequest('diag', null as unknown as Diag);
  app.addHook('onRequest', (req, _reply, done) => {
    const requestId = (req as { id?: string }).id;
    (req as unknown as { diag: Diag }).diag = {
      emit(ev) {
        return app.diag.emit({ ...ev, requestId: ev.requestId ?? requestId });
      },
    };
    done();
  });
});
