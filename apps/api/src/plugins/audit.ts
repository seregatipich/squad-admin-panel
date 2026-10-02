import fp from 'fastify-plugin';
import { writeRequestAudit } from '../lib/request-audit.js';

/**
 * Writes one `audit_log` row per response of a route that declares
 * `config.audit` — successes and denied or rejected attempts alike, unless the
 * handler already wrote the row inside its own transaction
 * (`auditRequestInTransaction`).
 *
 * A failed anonymous request (an auth-hook 401/403, or a public route's
 * 4xx/5xx) is not recorded: it changed nothing, and letting unauthenticated
 * traffic append to the undeletable, globally locked hash chain would let
 * anyone bloat it and stall valid audit writes (#37). A request that names its
 * own actor (a signed webhook) counts as authenticated. The query string is
 * dropped and the path and User-Agent are capped, since both are
 * client-controlled.
 */
export default fp(async (app) => {
  app.addHook('onResponse', async (req, reply) => {
    const auditCfg = req.routeOptions?.config?.audit;
    if (auditCfg === undefined) return;
    if (auditCfg === false || auditCfg === 'manual') return;
    if (req.auditWritten) return;
    if (!req.user && !req.auditSnapshots?.actor && reply.statusCode >= 400) return;
    try {
      await writeRequestAudit(app.db, req, reply.statusCode, Math.round(reply.elapsedTime));
    } catch (err) {
      app.log.error({ err: (err as Error).message, action: auditCfg.action }, 'audit write failed');
    }
  });
});
