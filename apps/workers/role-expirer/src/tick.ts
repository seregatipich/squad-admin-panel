import { type DatabaseClient, enqueueAdminsCfgSyncForAllServers } from '@squad/db';
import { auditLog, players, roles, sessions, vipSubscriptions, vipTiers } from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { LIVE_BUS_CHANNEL } from './system-events.js';

export interface ExpiredRoleAssignment {
  playerId: string;
  roleId: string;
  roleExpiresAt: Date;
  roleComment: string | null;
}

export interface RoleExpiryAuditEntry {
  actor: { kind: 'system'; label: 'role-expirer' };
  actorIp: null;
  actionType: 'player.role.expire';
  targetType: 'player';
  targetId: string;
  before: {
    role_id: string;
    role_expires_at: string;
    role_comment: string | null;
  };
  after: { role_id: null; role_expires_at: null; role_comment: null };
  context: Record<string, unknown>;
  statusCode: 200;
}

export interface AdminsCfgSyncEvent {
  /** `player.role.assign` is emitted by the VIPSUB-5 renewal tick. */
  reason: 'player.role.expire' | 'player.role.assign';
  actor_player_id: null;
  enqueued_at: string;
  request_id: string;
}

export interface RoleExpiryTickDeps {
  now?: Date;
  findExpiredAssignments(now: Date): Promise<ExpiredRoleAssignment[]>;
  /**
   * Clears expired assignments in one transaction. For every row the
   * conditional UPDATE actually clears, the audit entry is written and the
   * player's sessions are deleted inside that same transaction (#992): a
   * throwing audit write or session delete used to leave `role_id` already
   * NULL — so the next tick never reprocesses it — with no `audit_log` row
   * and live, un-revoked sessions. `revokedSessionIds` carries what was
   * deleted so the caller can do the Redis-only fan-out (cache invalidation,
   * live-bus publish) as a separate, best-effort step after commit.
   */
  clearExpiredAssignments(
    assignments: ExpiredRoleAssignment[],
    now: Date,
    event: AdminsCfgSyncEvent,
  ): Promise<{
    cleared: ExpiredRoleAssignment[];
    enqueued: number;
    revokedSessionIds: Map<string, string[]>;
  }>;
  invalidatePermissionCache(playerId: string): void;
  /** Best-effort, post-commit Redis fan-out for the sessions `clearExpiredAssignments` already deleted. */
  notifySessionsRevoked(playerId: string, sessionIds: string[]): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface RoleExpiryTickResult {
  expired: number;
  enqueued: number;
}

export async function runRoleExpiryTick(deps: RoleExpiryTickDeps): Promise<RoleExpiryTickResult> {
  const now = deps.now ?? new Date();
  try {
    const expired = await deps.findExpiredAssignments(now);
    if (expired.length === 0) {
      await deps.diag.emit({
        component: 'worker-role-expirer',
        kind: 'role_expirer.run_ok',
        severity: 'info',
        message: 'expired 0 role assignments',
        payload: { expired: 0, enqueued: 0 },
      });
      return { expired: 0, enqueued: 0 };
    }

    const event: AdminsCfgSyncEvent = {
      reason: 'player.role.expire',
      actor_player_id: null,
      enqueued_at: now.toISOString(),
      request_id: `role-expirer:${now.toISOString()}`,
    };
    const { cleared, enqueued, revokedSessionIds } = await deps.clearExpiredAssignments(
      expired,
      now,
      event,
    );
    if (cleared.length === 0) {
      await deps.diag.emit({
        component: 'worker-role-expirer',
        kind: 'role_expirer.run_ok',
        severity: 'info',
        message: 'expired 0 role assignments',
        payload: { expired: 0, enqueued: 0 },
      });
      return { expired: 0, enqueued: 0 };
    }

    for (const assignment of cleared) {
      deps.invalidatePermissionCache(assignment.playerId);
      // Best-effort and isolated per player: the DB-side clear, audit entry
      // and session delete already committed inside `clearExpiredAssignments`
      // — a failed Redis cache-clear or live-bus publish here must not be
      // retried as if the role expiry itself had failed.
      try {
        await deps.notifySessionsRevoked(
          assignment.playerId,
          revokedSessionIds.get(assignment.playerId) ?? [],
        );
      } catch (err) {
        await deps.diag.emit({
          component: 'worker-role-expirer',
          kind: 'role_expirer.session_notify_failed',
          severity: 'warn',
          message: `session revoke notification failed for player ${assignment.playerId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          payload: { player_id: assignment.playerId },
        });
      }
    }

    await deps.diag.emit({
      component: 'worker-role-expirer',
      kind: 'role_expirer.run_ok',
      severity: 'info',
      message: `expired ${cleared.length} role assignment(s)`,
      payload: { expired: cleared.length, enqueued },
    });

    return { expired: cleared.length, enqueued };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.diag.emit({
      component: 'worker-role-expirer',
      kind: 'role_expirer.run_failed',
      severity: 'error',
      message: `role expiry failed: ${message}`,
      payload: { err: message },
    });
    throw err;
  }
}

export function createRoleExpiryDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'del' | 'publish'>,
  opts: { batchSize?: number } = {},
): Omit<RoleExpiryTickDeps, 'now' | 'diag'> {
  const batchSize = opts.batchSize ?? 500;
  return {
    findExpiredAssignments: (now) => findExpiredAssignments(db, now, batchSize),
    clearExpiredAssignments: (assignments, now, event) =>
      clearExpiredAssignments(db, assignments, now, event),
    invalidatePermissionCache: () => undefined,
    notifySessionsRevoked: (playerId, sessionIds) =>
      notifySessionsRevoked(redis, playerId, sessionIds),
  };
}

/**
 * How far past `role_expires_at` a subscription's `next_renewal_at` may sit
 * and still count as "about to renew" the role. Creation sets both to
 * ~now + days a few milliseconds apart, and a renewal that runs late moves
 * the role from `now` while the billing date keeps its own schedule, so the
 * two drift by up to one renewal interval (1 h by default).
 */
const SUBSCRIPTION_RENEWAL_GRACE = '1 day';

/**
 * Role assignments whose `role_expires_at` has passed and must be cleared.
 *
 * Excludes the system Owner role, and roles an active VIP subscription is
 * about to renew (#989): the expiry tick runs every minute while renewals run
 * hourly, so without this the role — and every session — would be dropped at
 * each period boundary and re-granted up to an hour later. The subscription
 * protects the role only while it maps to the player's current role and is
 * due no later than `SUBSCRIPTION_RENEWAL_GRACE` after the role expires; a
 * cancelled or `expired` subscription never does, so the paid period runs out
 * normally once the renewal tick gives up.
 */
export async function findExpiredAssignments(
  db: DatabaseClient,
  now: Date,
  limit: number,
): Promise<ExpiredRoleAssignment[]> {
  const rows = await db
    .select({
      playerId: players.id,
      roleId: players.roleId,
      roleExpiresAt: players.roleExpiresAt,
      roleComment: players.roleComment,
    })
    .from(players)
    .innerJoin(roles, eq(players.roleId, roles.id))
    .where(
      and(
        isNotNull(players.roleId),
        isNotNull(players.roleExpiresAt),
        lte(players.roleExpiresAt, now),
        sql`NOT (${roles.name} = 'Owner' AND ${roles.isSystemRole} = true)`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${vipSubscriptions}
          INNER JOIN ${vipTiers} ON ${vipTiers.id} = ${vipSubscriptions.tierId}
          WHERE ${vipSubscriptions.playerId} = ${players.id}
            AND ${vipSubscriptions.status} = 'active'
            AND ${vipTiers.roleId} = ${players.roleId}
            AND ${vipSubscriptions.nextRenewalAt}
              <= ${players.roleExpiresAt} + ${SUBSCRIPTION_RENEWAL_GRACE}::interval
        )`,
      ),
    )
    .orderBy(asc(players.roleExpiresAt))
    .limit(limit);

  return rows.flatMap((row) => {
    if (!row.roleId || !row.roleExpiresAt) return [];
    return [
      {
        playerId: row.playerId,
        roleId: row.roleId,
        roleExpiresAt: row.roleExpiresAt,
        roleComment: row.roleComment ?? null,
      },
    ];
  });
}

export async function clearExpiredAssignments(
  db: DatabaseClient,
  assignments: ExpiredRoleAssignment[],
  now: Date,
  event: AdminsCfgSyncEvent,
): Promise<{
  cleared: ExpiredRoleAssignment[];
  enqueued: number;
  revokedSessionIds: Map<string, string[]>;
}> {
  if (assignments.length === 0) {
    return { cleared: [], enqueued: 0, revokedSessionIds: new Map() };
  }
  return db.transaction(async (tx) => {
    const cleared: ExpiredRoleAssignment[] = [];
    const revokedSessionIds = new Map<string, string[]>();
    for (const assignment of assignments) {
      const [updated] = await tx
        .update(players)
        .set({
          roleId: null,
          roleExpiresAt: null,
          roleComment: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(players.id, assignment.playerId),
            eq(players.roleId, assignment.roleId),
            eq(players.roleExpiresAt, assignment.roleExpiresAt),
          ),
        )
        .returning({ id: players.id });
      if (!updated) continue;
      cleared.push(assignment);

      // Audit entry and session delete happen inside this same transaction
      // so they commit or roll back together with the role clear (#992).
      await writeRoleExpiryAuditEntry(tx, {
        actor: { kind: 'system', label: 'role-expirer' },
        actorIp: null,
        actionType: 'player.role.expire',
        targetType: 'player',
        targetId: assignment.playerId,
        before: {
          role_id: assignment.roleId,
          role_expires_at: assignment.roleExpiresAt.toISOString(),
          role_comment: assignment.roleComment,
        },
        after: { role_id: null, role_expires_at: null, role_comment: null },
        context: { expired_at: now.toISOString() },
        statusCode: 200,
      });
      const sessionIds = await deleteSessionRowsForPlayer(tx, assignment.playerId);
      if (sessionIds.length > 0) revokedSessionIds.set(assignment.playerId, sessionIds);
    }
    const { enqueued } =
      cleared.length === 0 ? { enqueued: 0 } : await enqueueAdminsCfgSyncForAllServers(tx, event);
    return { cleared, enqueued, revokedSessionIds };
  });
}

/** Narrower than `DatabaseClient` so a transaction handle (which lacks `$client`) can be passed too. */
type AuditEntryExecutor = Pick<DatabaseClient, 'insert'>;

export async function writeRoleExpiryAuditEntry(
  db: AuditEntryExecutor,
  entry: RoleExpiryAuditEntry,
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

/**
 * Deletes every session row for `playerId` and returns the ids deleted (empty
 * when there were none). DB-only — no Redis — so `clearExpiredAssignments`
 * can run it inside its own transaction and have the delete roll back with
 * everything else on a later failure (#992).
 */
/** Narrower than `DatabaseClient` so a transaction handle (which lacks `$client`) can be passed too. */
type SessionDeleteExecutor = Pick<DatabaseClient, 'delete'>;

async function deleteSessionRowsForPlayer(
  db: SessionDeleteExecutor,
  playerId: string,
): Promise<string[]> {
  // One statement, so a session created concurrently is either deleted and
  // returned here (its Redis key is cleared) or survives untouched in the DB.
  const rows = await db
    .delete(sessions)
    .where(eq(sessions.playerId, playerId))
    .returning({ id: sessions.id });
  return rows.map((row) => row.id);
}

/**
 * Clears the Redis session cache and pushes one `session.revoked` event per
 * session onto the live-bus channel, so a role that expires (panel access
 * lost) force-logs-out the player's open tabs in ≤5 s rather than only on
 * their next request. Best-effort: called after the DB delete has already
 * committed, so a failure here loses only the real-time push, never the
 * revocation itself.
 */
export async function notifySessionsRevoked(
  redis: Pick<Redis, 'del' | 'publish'>,
  playerId: string,
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return;
  await redis.del(...sessionIds.map((id) => `session:${id}`));
  const ts = new Date().toISOString();
  for (const sessionId of sessionIds) {
    await redis.publish(
      LIVE_BUS_CHANNEL,
      JSON.stringify({
        type: 'session.revoked',
        ts,
        data: { player_id: playerId, session_id: sessionId },
      }),
    );
  }
}

/**
 * Deletes every session for `playerId` (DB rows + Redis cache) and notifies
 * the live bus. Mirrors the API's `revokeAllForPlayer`
 * (`apps/api/src/lib/sessions.ts`); workers publish over Redis pub/sub because
 * they have no in-process `app.liveBus`. `clearExpiredAssignments` composes
 * `deleteSessionRowsForPlayer` and `notifySessionsRevoked` separately instead
 * of calling this, so the DB delete can run inside its own transaction.
 */
export async function revokeAllSessionsForPlayer(
  db: DatabaseClient,
  redis: Pick<Redis, 'del' | 'publish'>,
  playerId: string,
): Promise<void> {
  const sessionIds = await deleteSessionRowsForPlayer(db, playerId);
  await notifySessionsRevoked(redis, playerId, sessionIds);
}
