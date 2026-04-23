import type { DatabaseClient } from '@squad/db';
import { auditLog } from '@squad/db/schema';

export interface AuditConfig {
  action: string;
  resource: string;
  /** Set to `false` explicitly on safe read-only routes; everything else requires a config. */
}

export interface AuditEntryInput {
  actorUserId: string | null;
  actorIp: string | null;
  actorKind?: 'user' | 'system' | 'external';
  actionType: string;
  targetType: string | null;
  targetId: string | null;
  before?: unknown;
  after?: unknown;
  context: Record<string, unknown>;
  statusCode?: number;
  durationMs?: number;
  orgId?: string | null;
}

export async function writeAuditEntry(db: DatabaseClient, entry: AuditEntryInput): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    actorIp: entry.actorIp,
    actorKind: entry.actorKind ?? 'user',
    actionType: entry.actionType,
    targetType: entry.targetType,
    targetId: entry.targetId,
    beforeSnapshot: entry.before === undefined ? null : (entry.before as object),
    afterSnapshot: entry.after === undefined ? null : (entry.after as object),
    context: (entry.context ?? {}) as object,
    statusCode: entry.statusCode ?? null,
    durationMs: entry.durationMs ?? null,
    orgId: entry.orgId ?? null,
    rowHash: Buffer.from([]), // server-side trigger computes the real hash
  });
}
