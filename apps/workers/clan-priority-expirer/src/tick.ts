import { type DatabaseClient, enqueueAdminsCfgSyncForAllServers } from '@squad/db';
import { auditLog, clanMembers, clans } from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

export interface ExpiredClan {
  clanId: string;
  clanName: string;
  priorityExpiresAt: Date;
}

export interface ClanPriorityExpiryAuditEntry {
  actor: { kind: 'system'; label: 'clan-priority-expirer' };
  actorIp: null;
  actionType: 'clan.priority.expire';
  targetType: 'clan';
  targetId: string;
  before: { priority_expires_at: string; priority_expiry_processed: false };
  after: { priority_expiry_processed: true };
  context: Record<string, unknown>;
  statusCode: 200;
}

export interface AdminsCfgSyncEvent {
  reason: 'clan.priority.expire';
  actor_player_id: null;
  enqueued_at: string;
  request_id: string;
}

export interface ClanPriorityExpiryTickDeps {
  now?: Date;
  findExpiredUnprocessedClans(now: Date): Promise<ExpiredClan[]>;
  markProcessed(clanIds: string[], event: AdminsCfgSyncEvent): Promise<{ enqueued: number }>;
  writeAuditEntry(entry: ClanPriorityExpiryAuditEntry): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface ClanPriorityExpiryTickResult {
  expiredClans: number;
  enqueued: number;
}

/**
 * Detect clans whose `priority_expires_at` has crossed `now` and haven't
 * been processed yet, mark them processed, write one audit entry per clan,
 * and publish exactly one active admins-cfg sync so the config-sync worker
 * drops their members from the managed Admins.cfg segment.
 *
 * This never mutates `clan_members.has_priority` — the toggle state is
 * preserved so that extending `priority_expires_at` (via `PATCH
 * /clans/:id/expire`, which also resets `priority_expiry_processed`)
 * brings priorities back with no manual re-toggling.
 */
export async function runClanPriorityExpiryTick(
  deps: ClanPriorityExpiryTickDeps,
): Promise<ClanPriorityExpiryTickResult> {
  const now = deps.now ?? new Date();
  try {
    const expired = await deps.findExpiredUnprocessedClans(now);
    if (expired.length === 0) {
      await deps.diag.emit({
        component: 'worker-clan-priority-expirer',
        kind: 'clan_priority_expirer.run_ok',
        severity: 'info',
        message: 'expired 0 clan priority windows',
        payload: { expiredClans: 0, enqueued: 0 },
      });
      return { expiredClans: 0, enqueued: 0 };
    }

    const event: AdminsCfgSyncEvent = {
      reason: 'clan.priority.expire',
      actor_player_id: null,
      enqueued_at: now.toISOString(),
      request_id: `clan-priority-expirer:${now.toISOString()}`,
    };
    const { enqueued } = await deps.markProcessed(
      expired.map((clan) => clan.clanId),
      event,
    );

    for (const clan of expired) {
      await deps.writeAuditEntry({
        actor: { kind: 'system', label: 'clan-priority-expirer' },
        actorIp: null,
        actionType: 'clan.priority.expire',
        targetType: 'clan',
        targetId: clan.clanId,
        before: {
          priority_expires_at: clan.priorityExpiresAt.toISOString(),
          priority_expiry_processed: false,
        },
        after: { priority_expiry_processed: true },
        context: { clan_name: clan.clanName, expired_at: now.toISOString() },
        statusCode: 200,
      });
    }

    await deps.diag.emit({
      component: 'worker-clan-priority-expirer',
      kind: 'clan_priority_expirer.run_ok',
      severity: 'info',
      message: `expired ${expired.length} clan priority window(s)`,
      payload: { expiredClans: expired.length, enqueued },
    });

    return { expiredClans: expired.length, enqueued };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.diag.emit({
      component: 'worker-clan-priority-expirer',
      kind: 'clan_priority_expirer.run_failed',
      severity: 'error',
      message: `clan priority expiry failed: ${message}`,
      payload: { err: message },
    });
    throw err;
  }
}

export function createClanPriorityExpiryDeps(
  db: DatabaseClient,
): Omit<ClanPriorityExpiryTickDeps, 'now' | 'diag'> {
  return {
    findExpiredUnprocessedClans: (now) => findExpiredUnprocessedClans(db, now),
    markProcessed: (clanIds, event) => markProcessed(db, clanIds, event),
    writeAuditEntry: (entry) => writeClanPriorityExpiryAuditEntry(db, entry),
  };
}

const hasPriorityMemberExists = sql`EXISTS (
  SELECT 1 FROM ${clanMembers} cm WHERE cm.clan_id = ${clans.id} AND cm.has_priority
)`;

/**
 * Silently mark "empty" expired clans (no `has_priority` members at all)
 * as processed without an audit/sync — there is nothing to materialize or
 * remove from Admins.cfg for them, so surfacing them would be noise.
 */
async function markEmptyExpiredClansProcessed(db: DatabaseClient, now: Date): Promise<void> {
  await db
    .update(clans)
    .set({ priorityExpiryProcessed: true })
    .where(
      and(
        isNull(clans.deletedAt),
        lte(clans.priorityExpiresAt, now),
        eq(clans.priorityExpiryProcessed, false),
        sql`NOT ${hasPriorityMemberExists}`,
      ),
    );
}

export async function findExpiredUnprocessedClans(
  db: DatabaseClient,
  now: Date,
): Promise<ExpiredClan[]> {
  await markEmptyExpiredClansProcessed(db, now);
  const rows = await db
    .select({
      clanId: clans.id,
      clanName: clans.name,
      priorityExpiresAt: clans.priorityExpiresAt,
    })
    .from(clans)
    .where(
      and(
        isNull(clans.deletedAt),
        lte(clans.priorityExpiresAt, now),
        eq(clans.priorityExpiryProcessed, false),
        hasPriorityMemberExists,
      ),
    )
    .orderBy(asc(clans.priorityExpiresAt));

  return rows.flatMap((row) => {
    if (!row.priorityExpiresAt) return [];
    return [
      { clanId: row.clanId, clanName: row.clanName, priorityExpiresAt: row.priorityExpiresAt },
    ];
  });
}

export async function markProcessed(
  db: DatabaseClient,
  clanIds: string[],
  event: AdminsCfgSyncEvent,
): Promise<{ enqueued: number }> {
  if (clanIds.length === 0) return { enqueued: 0 };
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(clans)
      .set({ priorityExpiryProcessed: true })
      .where(inArray(clans.id, clanIds))
      .returning({ id: clans.id });
    if (updated.length === 0) return { enqueued: 0 };
    return enqueueAdminsCfgSyncForAllServers(tx, event);
  });
}

export async function writeClanPriorityExpiryAuditEntry(
  db: DatabaseClient,
  entry: ClanPriorityExpiryAuditEntry,
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
