import fp from 'fastify-plugin';
import { writeAuditEntry } from '../lib/audit.js';

/**
 * Installs a global onResponse hook that persists an audit row for any
 * route whose `config.audit` is defined. Routes that explicitly set
 * `config.audit = false` are allowed to pass (for rare read-only GET
 * endpoints); any mutation without either a config or the explicit
 * `false` opt-out fails the CI "no-audit-bypass" test.
 */
export default fp(async (app) => {
  app.addHook('onResponse', async (req, reply) => {
    const auditCfg = req.routeOptions?.config?.audit;
    if (auditCfg === undefined) return;
    if (auditCfg === false) return;
    try {
      await writeAuditEntry(app.db, {
        actorUserId: req.user?.id ?? null,
        actorIp: req.ip ?? null,
        actorKind: req.user ? 'user' : 'system',
        actionType: auditCfg.action,
        targetType: auditCfg.resource,
        targetId: extractTargetId(req.params),
        context: {
          requestId: req.id,
          method: req.method,
          url: req.url,
          statusCode: reply.statusCode,
          userAgent: req.headers['user-agent'] ?? null,
        },
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      });
    } catch (err) {
      app.log.error({ err: (err as Error).message, action: auditCfg.action }, 'audit write failed');
    }
  });
});

function extractTargetId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const p = params as Record<string, unknown>;
  if (typeof p.id === 'string') return p.id;
  if (typeof p.serverId === 'string') return p.serverId;
  if (typeof p.userId === 'string') return p.userId;
  return null;
}
