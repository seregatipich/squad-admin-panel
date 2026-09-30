import type { DatabaseClient } from '@squad/db';
import { auditLog } from '@squad/db/schema';
import type Redis from 'ioredis';

/** Redis pub/sub channel the API's live-bus subscribes to for real-time fan-out. */
export const LIVE_BUS_CHANNEL = 'live-bus';

/** Fields of an `audit_log` row written by this worker as the `role-expirer` system actor. */
export interface SystemAuditEntry {
  actor: { kind: 'system'; label: 'role-expirer' };
  actorIp: null;
  actionType: string;
  targetType: 'player';
  targetId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  context: Record<string, unknown>;
  statusCode: 200;
}

/**
 * Appends one `audit_log` row for a system-actor transition. `rowHash` is a
 * placeholder: the `audit_log_append` trigger computes the real hash chain.
 */
export async function writeSystemAuditEntry(
  db: Pick<DatabaseClient, 'insert'>,
  entry: SystemAuditEntry,
): Promise<void> {
  await db.insert(auditLog).values({
    actorKind: entry.actor.kind,
    actorPlayerId: null,
    actorTokenId: null,
    actorSystemLabel: entry.actor.label,
    actorIp: entry.actorIp,
    actionType: entry.actionType,
    targetType: entry.targetType,
    targetId: entry.targetId,
    beforeSnapshot: entry.before,
    afterSnapshot: entry.after,
    context: entry.context,
    statusCode: entry.statusCode,
    rowHash: Buffer.from([]),
  });
}

/** Publishes an `alert.triggered` live-bus frame carrying `payload`. */
export async function publishAlertFrame(
  redis: Pick<Redis, 'publish'>,
  payload: unknown,
): Promise<void> {
  await redis.publish(
    LIVE_BUS_CHANNEL,
    JSON.stringify({ type: 'alert.triggered', ts: new Date().toISOString(), data: payload }),
  );
}
