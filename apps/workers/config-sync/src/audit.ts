import type { DatabaseClient } from '@squad/db';
import { auditLog } from '@squad/db/schema';

type AuditTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export interface AuditEntry {
  actorPlayerId: string | null;
  actionType: string;
  targetType: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  context: Record<string, unknown>;
}

/**
 * Appends an audit_log row from the worker. The hash chain is not computed
 * here: the `audit_log_append` BEFORE INSERT trigger takes the chain lock and
 * overwrites `prev_hash`/`row_hash`, so `rowHash` only carries the placeholder
 * the NOT NULL column requires (same as the API and the other workers).
 */
async function appendWorkerAuditRow(tx: AuditTransaction, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorKind: entry.actorPlayerId ? 'steam' : 'system',
    actorPlayerId: entry.actorPlayerId,
    actorTokenId: null,
    actorSystemLabel: entry.actorPlayerId ? null : 'worker-config-sync',
    actorIp: null,
    actionType: entry.actionType,
    targetType: entry.targetType,
    targetId: entry.targetId,
    beforeSnapshot: entry.before,
    afterSnapshot: entry.after,
    context: entry.context,
    statusCode: null,
    durationMs: null,
    rowHash: Buffer.from([]),
  });
}

export async function appendWorkerAuditInTransaction(
  tx: AuditTransaction,
  entry: AuditEntry,
): Promise<void> {
  await appendWorkerAuditRow(tx, entry);
}

export async function appendWorkerAudit(db: DatabaseClient, entry: AuditEntry): Promise<void> {
  await db.transaction((tx) => appendWorkerAuditRow(tx, entry));
}
