import type { DatabaseClient } from '@squad/db';
import { auditLog } from '@squad/db/schema';

export interface AuditConfig {
  action: string;
  resource: string;
}

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

export async function writeAuditEntry(db: DatabaseClient, entry: AuditEntryInput): Promise<void> {
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
