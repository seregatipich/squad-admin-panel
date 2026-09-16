import { type DatabaseClient, enqueueAdminsCfgSyncForAllServers } from '@squad/db';
import { auditLog, players, roles, sessions } from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type Redis from 'ioredis';

/** Redis pub/sub channel the API's live-bus subscribes to for real-time fan-out. */
const LIVE_BUS_CHANNEL = 'live-bus';

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
  clearExpiredAssignments(
    assignments: ExpiredRoleAssignment[],
    now: Date,
    event: AdminsCfgSyncEvent,
  ): Promise<{ cleared: ExpiredRoleAssignment[]; enqueued: number }>;
  writeAuditEntry(entry: RoleExpiryAuditEntry): Promise<void>;
  invalidatePermissionCache(playerId: string): void;
  revokeAllForPlayer(playerId: string): Promise<void>;
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
    const { cleared, enqueued } = await deps.clearExpiredAssignments(expired, now, event);
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
      await deps.writeAuditEntry({
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
      deps.invalidatePermissionCache(assignment.playerId);
      await deps.revokeAllForPlayer(assignment.playerId);
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
    writeAuditEntry: (entry) => writeRoleExpiryAuditEntry(db, entry),
    invalidatePermissionCache: () => undefined,
    revokeAllForPlayer: (playerId) => revokeAllSessionsForPlayer(db, redis, playerId),
  };
}

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
): Promise<{ cleared: ExpiredRoleAssignment[]; enqueued: number }> {
  if (assignments.length === 0) return { cleared: [], enqueued: 0 };
  return db.transaction(async (tx) => {
    const cleared: ExpiredRoleAssignment[] = [];
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
      if (updated) cleared.push(assignment);
    }
    const { enqueued } =
      cleared.length === 0 ? { enqueued: 0 } : await enqueueAdminsCfgSyncForAllServers(tx, event);
    return { cleared, enqueued };
  });
}

export async function writeRoleExpiryAuditEntry(
  db: DatabaseClient,
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
 * Deletes every session for `playerId` (DB rows + Redis cache) and pushes one
 * `session.revoked` event per session onto the live-bus channel, so a role that
 * expires (panel access lost) force-logs-out the player's open tabs in ≤5 s
 * rather than only on their next request. Mirrors the API's `revokeAllForPlayer`
 * (`apps/api/src/lib/sessions.ts`); workers publish over Redis pub/sub because
 * they have no in-process `app.liveBus`.
 */
export async function revokeAllSessionsForPlayer(
  db: DatabaseClient,
  redis: Pick<Redis, 'del' | 'publish'>,
  playerId: string,
): Promise<void> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.playerId, playerId));
  if (rows.length === 0) return;
  await db.delete(sessions).where(eq(sessions.playerId, playerId));
  await redis.del(...rows.map((row) => `session:${row.id}`));
  const ts = new Date().toISOString();
  for (const row of rows) {
    await redis.publish(
      LIVE_BUS_CHANNEL,
      JSON.stringify({
        type: 'session.revoked',
        ts,
        data: { player_id: playerId, session_id: row.id },
      }),
    );
  }
}
