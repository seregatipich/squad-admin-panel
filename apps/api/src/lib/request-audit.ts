import type { DatabaseClient } from '@squad/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type AuditActor, type AuditTransaction, writeAuditEntry } from './audit.js';

/** Longest request path and User-Agent kept in an audit row's context. */
const CONTEXT_FIELD_MAX_LENGTH = 512;

/**
 * Builds and appends the `audit_log` row of one request from its
 * `config.audit` declaration and `req.auditSnapshots`.
 *
 * Both the declarative `onResponse` hook (`plugins/audit.ts`) and the handlers
 * that must commit the row atomically with their change
 * ({@link auditRequestInTransaction}) write through this one function, so a
 * route's row has the same shape wherever it was written.
 *
 * @param db - The database client, or the mutating transaction.
 * @param req - Request of a route that declares `config.audit: { action, resource }`.
 * @param statusCode - HTTP status recorded in the row and its context.
 * @param durationMs - Handler duration; omitted when written before the response.
 * @returns `false` when the route declares no `{ action, resource }` audit, else `true`.
 * @throws Whatever the insert throws (e.g. a hash-chain trigger failure).
 */
export async function writeRequestAudit(
  db: DatabaseClient | AuditTransaction,
  req: FastifyRequest,
  statusCode: number,
  durationMs?: number,
): Promise<boolean> {
  const auditCfg = req.routeOptions?.config?.audit;
  if (auditCfg === undefined || auditCfg === false || auditCfg === 'manual') return false;
  const actor: AuditActor =
    req.auditSnapshots?.actor ??
    (req.user
      ? { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null }
      : { kind: 'system', label: 'http-anonymous' });
  await writeAuditEntry(db, {
    actor,
    actorIp: req.ip ?? null,
    actionType: req.auditSnapshots?.action ?? auditCfg.action,
    targetType: auditCfg.resource,
    targetId: req.auditSnapshots?.targetId ?? extractTargetId(req.params),
    // Routes opt in by assigning `req.auditSnapshots` in the handler; when
    // they don't, these stay undefined and writeAuditEntry stores null.
    before: req.auditSnapshots?.before,
    after: req.auditSnapshots?.after,
    context: {
      ...req.auditSnapshots?.context,
      requestId: req.id,
      method: req.method,
      url: req.url.split('?', 1)[0]?.slice(0, CONTEXT_FIELD_MAX_LENGTH),
      statusCode,
      userAgent: req.headers['user-agent']?.slice(0, CONTEXT_FIELD_MAX_LENGTH) ?? null,
    },
    statusCode,
    durationMs,
  });
  return true;
}

/**
 * Writes the request's audit row inside the transaction that applies the
 * change, so a failed audit insert rolls the change back instead of leaving it
 * committed but unaudited. The route still declares `config.audit`; the
 * `onResponse` hook skips a request whose row was written here, so the row is
 * written exactly once. Set `req.auditSnapshots` first, and set the success
 * status on `reply` before calling when it is not 200.
 *
 * @param tx - The mutating transaction.
 * @param req - Request of a route that declares `config.audit: { action, resource }`.
 * @param reply - Reply whose current status code is recorded.
 * @throws Whatever the insert throws; the transaction then rolls back.
 */
export async function auditRequestInTransaction(
  tx: AuditTransaction,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (await writeRequestAudit(tx, req, reply.statusCode)) req.auditWritten = true;
}

function extractTargetId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const p = params as Record<string, unknown>;
  if (typeof p.id === 'string') return p.id;
  if (typeof p.serverId === 'string') return p.serverId;
  if (typeof p.playerId === 'string') return p.playerId;
  return null;
}
