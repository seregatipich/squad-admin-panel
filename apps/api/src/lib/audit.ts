import type { DatabaseClient } from '@squad/db';
import { auditLog } from '@squad/db/schema';

export type AuditActor =
  | { kind: 'steam'; playerId: string; tokenId?: string | null }
  | { kind: 'system'; label: string };

export interface AuditEntryInput {
  actor: AuditActor;
  actorIp: string | null;
  actionType: string;
  targetType: string | null;
  targetId: string | null;
  before?: unknown;
  after?: unknown;
  context: Record<string, unknown>;
  statusCode?: number;
  durationMs?: number;
}

/** A transaction handle from `DatabaseClient.transaction`. */
export type AuditTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

/**
 * Append one row to the `audit_log` hash chain.
 *
 * Pass the mutating transaction (`tx`) rather than `app.db` whenever the audit
 * row must be atomic with the change it records: a failed audit insert then
 * rolls the change back instead of leaving it committed but unaudited.
 *
 * @param db - The database client or an open transaction.
 * @param entry - Actor, action, target and snapshots to record.
 * @throws Whatever the insert throws (e.g. a hash-chain trigger failure).
 */
export async function writeAuditEntry(
  db: DatabaseClient | AuditTransaction,
  entry: AuditEntryInput,
): Promise<void> {
  const actor = entry.actor;
  await db.insert(auditLog).values({
    actorKind: actor.kind,
    actorPlayerId: actor.kind === 'steam' ? actor.playerId : null,
    actorTokenId: actor.kind === 'steam' ? (actor.tokenId ?? null) : null,
    actorSystemLabel: actor.kind === 'system' ? actor.label : null,
    actorIp: entry.actorIp,
    actionType: entry.actionType,
    targetType: entry.targetType,
    targetId: entry.targetId,
    beforeSnapshot: entry.before === undefined ? null : (entry.before as object),
    afterSnapshot: entry.after === undefined ? null : (entry.after as object),
    context: (entry.context ?? {}) as object,
    statusCode: entry.statusCode ?? null,
    durationMs: entry.durationMs ?? null,
    rowHash: Buffer.from([]),
  });
}
