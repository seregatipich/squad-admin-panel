import fp from 'fastify-plugin';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';

/** Longest request path and User-Agent kept in an audit row's context. */
const CONTEXT_FIELD_MAX_LENGTH = 512;

/**
 * Writes one `audit_log` row per response of a route that declares
 * `config.audit`. An anonymous request the auth hook rejected (401/403) is not
 * recorded: it changed nothing, and letting unauthenticated traffic append to
 * the undeletable, globally locked hash chain would let anyone bloat it and
 * stall legitimate audit writes (#37). The query string is dropped and the
 * path and User-Agent are capped, since both are client-controlled.
 */
export default fp(async (app) => {
  app.addHook('onResponse', async (req, reply) => {
    const auditCfg = req.routeOptions?.config?.audit;
    if (auditCfg === undefined) return;
    if (auditCfg === false) return;
    if (!req.user && (reply.statusCode === 401 || reply.statusCode === 403)) return;
    const actor: AuditActor = req.user
      ? { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null }
      : { kind: 'system', label: 'http-anonymous' };
    try {
      await writeAuditEntry(app.db, {
        actor,
        actorIp: req.ip ?? null,
        actionType: auditCfg.action,
        targetType: auditCfg.resource,
        targetId: req.auditSnapshots?.targetId ?? extractTargetId(req.params),
        // Routes opt in by assigning `req.auditSnapshots` in the handler; when
        // they don't, these stay undefined and writeAuditEntry stores null,
        // exactly as before.
        before: req.auditSnapshots?.before,
        after: req.auditSnapshots?.after,
        context: {
          requestId: req.id,
          method: req.method,
          url: req.url.split('?', 1)[0]?.slice(0, CONTEXT_FIELD_MAX_LENGTH),
          statusCode: reply.statusCode,
          userAgent: req.headers['user-agent']?.slice(0, CONTEXT_FIELD_MAX_LENGTH) ?? null,
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
