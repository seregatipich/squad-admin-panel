import type { DatabaseClient } from '@squad/db';
import { auditLog, clanMembers, clans, servers } from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type Redis from 'ioredis';

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
  markProcessed(clanIds: string[]): Promise<void>;
  writeAuditEntry(entry: ClanPriorityExpiryAuditEntry): Promise<void>;
  publishAdminsCfgSync(event: AdminsCfgSyncEvent): Promise<{ enqueued: number }>;
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

    await deps.markProcessed(expired.map((clan) => clan.clanId));

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

    const syncResult = await deps.publishAdminsCfgSync({
      reason: 'clan.priority.expire',
      actor_player_id: null,
      enqueued_at: now.toISOString(),
      request_id: `clan-priority-expirer:${now.toISOString()}`,
    });

    await deps.diag.emit({
      component: 'worker-clan-priority-expirer',
      kind: 'clan_priority_expirer.run_ok',
      severity: 'info',
      message: `expired ${expired.length} clan priority window(s)`,
      payload: { expiredClans: expired.length, enqueued: syncResult.enqueued },
    });

    return { expiredClans: expired.length, enqueued: syncResult.enqueued };
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
  redis: Pick<Redis, 'pipeline'>,
): Omit<ClanPriorityExpiryTickDeps, 'now' | 'diag'> {
  return {
    findExpiredUnprocessedClans: (now) => findExpiredUnprocessedClans(db, now),
    markProcessed: (clanIds) => markProcessed(db, clanIds),
    writeAuditEntry: (entry) => writeClanPriorityExpiryAuditEntry(db, entry),
    publishAdminsCfgSync: (event) => publishAdminsCfgSyncForAllServers(db, redis, event),
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

export async function markProcessed(db: DatabaseClient, clanIds: string[]): Promise<void> {
  if (clanIds.length === 0) return;
  await db.update(clans).set({ priorityExpiryProcessed: true }).where(inArray(clans.id, clanIds));
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

export async function publishAdminsCfgSyncForAllServers(
  db: Pick<DatabaseClient, 'select'>,
  redis: Pick<Redis, 'pipeline'>,
  event: AdminsCfgSyncEvent,
): Promise<{ enqueued: number }> {
  const rows = await db.select({ id: servers.id }).from(servers).where(isNull(servers.deletedAt));
  if (rows.length === 0) return { enqueued: 0 };
  const payload = JSON.stringify(event);
  const pipeline = redis.pipeline();
  for (const row of rows) {
    pipeline.xadd(`events:admins-cfg-sync:${row.id}`, 'MAXLEN', '~', '500', '*', 'event', payload);
  }
  await pipeline.exec();
  return { enqueued: rows.length };
}
