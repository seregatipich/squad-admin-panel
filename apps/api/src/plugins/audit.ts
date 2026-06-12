import fp from 'fastify-plugin';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';

export default fp(async (app) => {
  app.addHook('onResponse', async (req, reply) => {
    const auditCfg = req.routeOptions?.config?.audit;
    if (auditCfg === undefined) return;
    if (auditCfg === false) return;
    const actor: AuditActor = req.user
      ? { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null }
      : { kind: 'system', label: 'http-anonymous' };
    try {
      await writeAuditEntry(app.db, {
        actor,
        actorIp: req.ip ?? null,
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
  if (typeof p.playerId === 'string') return p.playerId;
  return null;
}
