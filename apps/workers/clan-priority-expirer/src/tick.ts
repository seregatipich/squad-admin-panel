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
  /**
   * Marks the candidates processed, writes their audit rows and enqueues the
   * sync in one transaction; returns the clans actually expired (see
   * {@link expireClans}).
   */
  expireClans(
    candidates: ExpiredClan[],
    now: Date,
    event: AdminsCfgSyncEvent,
  ): Promise<{ expired: ExpiredClan[]; enqueued: number }>;
  diag: Pick<Diag, 'emit'>;
}

export interface ClanPriorityExpiryTickResult {
  expiredClans: number;
  enqueued: number;
}

/**
 * Detect clans whose `priority_expires_at` has crossed `now` and haven't
 * been processed yet, then — in one transaction — mark them processed, write
 * one audit entry per clan, and enqueue exactly one active admins-cfg sync so
 * the config-sync worker drops their members from the managed Admins.cfg
 * segment. A clan extended between the select and the update is left alone.
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
    const { expired: processed, enqueued } = await deps.expireClans(expired, now, event);

    await deps.diag.emit({
      component: 'worker-clan-priority-expirer',
      kind: 'clan_priority_expirer.run_ok',
      severity: 'info',
      message: `expired ${processed.length} clan priority window(s)`,
      payload: { expiredClans: processed.length, enqueued },
    });

    return { expiredClans: processed.length, enqueued };
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
    expireClans: (candidates, now, event) => expireClans(db, candidates, now, event),
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

/** The audit entry recorded for one expired clan. */
export function buildClanPriorityExpiryAuditEntry(
  clan: ExpiredClan,
  now: Date,
): ClanPriorityExpiryAuditEntry {
  return {
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
  };
}

/**
 * Expires `candidates` in one transaction: sets `priority_expiry_processed`,
 * writes one audit row per clan and enqueues the admins-cfg sync, so a
 * failure part-way leaves every clan unprocessed for the next tick instead of
 * processed without its audit row (#866).
 *
 * The update re-checks the selection conditions (not processed, expired, not
 * deleted): a `PATCH /api/v1/clans/:id/expire` that extended a clan after it
 * was selected reset its flag, and must not be overwritten (#865). Only the
 * clans the update actually changed are audited and returned.
 */
export async function expireClans(
  db: DatabaseClient,
  candidates: ExpiredClan[],
  now: Date,
  event: AdminsCfgSyncEvent,
): Promise<{ expired: ExpiredClan[]; enqueued: number }> {
  if (candidates.length === 0) return { expired: [], enqueued: 0 };
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(clans)
      .set({ priorityExpiryProcessed: true })
      .where(
        and(
          inArray(
            clans.id,
            candidates.map((clan) => clan.clanId),
          ),
          eq(clans.priorityExpiryProcessed, false),
          lte(clans.priorityExpiresAt, now),
          isNull(clans.deletedAt),
        ),
      )
      .returning({ id: clans.id });
    const updatedIds = new Set(updated.map((row) => row.id));
    const expired = candidates.filter((clan) => updatedIds.has(clan.clanId));
    if (expired.length === 0) return { expired, enqueued: 0 };

    for (const clan of expired) {
      await writeClanPriorityExpiryAuditEntry(tx, buildClanPriorityExpiryAuditEntry(clan, now));
    }
    const { enqueued } = await enqueueAdminsCfgSyncForAllServers(tx, event);
    return { expired, enqueued };
  });
}

export async function writeClanPriorityExpiryAuditEntry(
  db: Pick<DatabaseClient, 'insert'>,
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
