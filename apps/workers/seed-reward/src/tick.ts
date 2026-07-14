import type { DatabaseClient } from '@squad/db';
import {
  auditLog,
  economySettings,
  playerDailyPresence,
  players,
  roles,
  servers,
  sessions,
} from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type Redis from 'ioredis';

const ROLLING_WINDOW_DAYS = 30;
const SECONDS_PER_HOUR = 3600;

export type SeedRewardChangeKind = 'granted' | 'revoked';

export interface SeedRewardChange {
  kind: SeedRewardChangeKind;
  playerId: string;
  beforeRoleId: string | null;
  afterRoleId: string | null;
  seedSeconds: number;
}

export interface SeedRewardReconcileResult {
  configured: boolean;
  fromDay: string;
  toDay: string;
  rewardRoleId: string | null;
  thresholdSeconds: number;
  changes: SeedRewardChange[];
}

export interface SeedRewardSyncEvent {
  reason: 'seed.reward.reconcile';
  actor_player_id: null;
  enqueued_at: string;
  request_id: string;
}

export interface SeedRewardTickDeps {
  now?: Date;
  reconcileAssignments(now: Date): Promise<SeedRewardReconcileResult>;
  publishAdminsCfgSync(event: SeedRewardSyncEvent): Promise<{ enqueued: number }>;
  invalidatePermissionCache(playerId: string): void;
  revokeAllForPlayer(playerId: string): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface SeedRewardTickResult {
  skipped: boolean;
  granted: number;
  revoked: number;
  enqueued: number;
}

/**
 * Reconcile rolling 30-day seed totals with the configured reward role.
 * Role changes use the ROLE-2 side effects: system audit rows, permission
 * cache invalidation, panel-session revocation, and Admins.cfg sync.
 */
export async function runSeedRewardTick(deps: SeedRewardTickDeps): Promise<SeedRewardTickResult> {
  const now = deps.now ?? new Date();
  try {
    const reconciliation = await deps.reconcileAssignments(now);
    if (!reconciliation.configured) {
      await deps.diag.emit({
        component: 'worker-seed-reward',
        kind: 'seed_reward.run_ok',
        severity: 'info',
        message: 'seed reward role is not configured',
        payload: { skipped: true, granted: 0, revoked: 0, enqueued: 0 },
      });
      return { skipped: true, granted: 0, revoked: 0, enqueued: 0 };
    }

    for (const change of reconciliation.changes) {
      deps.invalidatePermissionCache(change.playerId);
      await deps.revokeAllForPlayer(change.playerId);
    }

    const syncResult =
      reconciliation.changes.length === 0
        ? { enqueued: 0 }
        : await deps.publishAdminsCfgSync({
            reason: 'seed.reward.reconcile',
            actor_player_id: null,
            enqueued_at: now.toISOString(),
            request_id: `seed-reward:${now.toISOString()}`,
          });
    const granted = reconciliation.changes.filter((change) => change.kind === 'granted').length;
    const revoked = reconciliation.changes.length - granted;

    await deps.diag.emit({
      component: 'worker-seed-reward',
      kind: 'seed_reward.run_ok',
      severity: 'info',
      message: `reconciled seed rewards: ${granted} granted, ${revoked} revoked`,
      payload: {
        skipped: false,
        granted,
        revoked,
        enqueued: syncResult.enqueued,
        fromDay: reconciliation.fromDay,
        toDay: reconciliation.toDay,
        rewardRoleId: reconciliation.rewardRoleId,
        thresholdSeconds: reconciliation.thresholdSeconds,
      },
    });

    return { skipped: false, granted, revoked, enqueued: syncResult.enqueued };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.diag.emit({
      component: 'worker-seed-reward',
      kind: 'seed_reward.run_failed',
      severity: 'error',
      message: `seed reward reconciliation failed: ${message}`,
      payload: { error: message },
    });
    throw error;
  }
}

export function createSeedRewardDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'del' | 'pipeline'>,
): Omit<SeedRewardTickDeps, 'now' | 'diag'> {
  return {
    reconcileAssignments: (now) => reconcileSeedRewardAssignments(db, now),
    publishAdminsCfgSync: (event) => publishAdminsCfgSyncForAllServers(db, redis, event),
    invalidatePermissionCache: () => undefined,
    revokeAllForPlayer: (playerId) => revokeAllSessionsForPlayer(db, redis, playerId),
  };
}

/** Return the inclusive UTC day window containing exactly 30 calendar days. */
export function rollingSeedRewardWindow(now: Date): { fromDay: string; toDay: string } {
  const toDay = now.toISOString().slice(0, 10);
  const from = new Date(`${toDay}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - (ROLLING_WINDOW_DAYS - 1));
  return { fromDay: from.toISOString().slice(0, 10), toDay };
}

/**
 * Apply reward grants and revocations atomically and write their audit rows.
 * A conditional update protects a concurrent manual ROLE-2 assignment from
 * being overwritten after the reconciliation snapshot was read.
 */
export async function reconcileSeedRewardAssignments(
  db: DatabaseClient,
  now: Date,
): Promise<SeedRewardReconcileResult> {
  const window = rollingSeedRewardWindow(now);
  return db.transaction(async (tx) => {
    const [settings] = await tx
      .select({
        rewardRoleId: economySettings.seedRewardRoleId,
        thresholdHours: economySettings.seedRewardThresholdHoursPerMonth,
      })
      .from(economySettings)
      .where(eq(economySettings.id, 1))
      .limit(1);
    const rewardRoleId = settings?.rewardRoleId ?? null;
    const thresholdSeconds = (settings?.thresholdHours ?? 0) * SECONDS_PER_HOUR;
    if (!rewardRoleId) {
      return { configured: false, ...window, rewardRoleId, thresholdSeconds, changes: [] };
    }

    const [rewardRole] = await tx
      .select({ panelAccess: roles.panelAccess })
      .from(roles)
      .where(eq(roles.id, rewardRoleId))
      .limit(1);
    if (!rewardRole) throw new Error('configured seed reward role does not exist');
    if (rewardRole.panelAccess) {
      throw new Error('configured seed reward role must not grant panel access');
    }

    const states = await tx
      .select({
        playerId: players.id,
        currentRoleId: players.roleId,
        roleExpiresAt: players.roleExpiresAt,
        roleComment: players.roleComment,
        seedSeconds: sql<number>`COALESCE(SUM(${playerDailyPresence.seedSeconds}), 0)::bigint`,
      })
      .from(players)
      .leftJoin(
        playerDailyPresence,
        and(
          eq(playerDailyPresence.playerId, players.id),
          gte(playerDailyPresence.day, window.fromDay),
          lte(playerDailyPresence.day, window.toDay),
        ),
      )
      .groupBy(players.id);

    const changes: SeedRewardChange[] = [];
    for (const state of states) {
      const seedSeconds = Number(state.seedSeconds);
      const qualifies = seedSeconds >= thresholdSeconds;
      const kind: SeedRewardChangeKind | null =
        qualifies && state.currentRoleId !== rewardRoleId
          ? 'granted'
          : !qualifies && state.currentRoleId === rewardRoleId
            ? 'revoked'
            : null;
      if (!kind) continue;

      const afterRoleId = kind === 'granted' ? rewardRoleId : null;
      const currentRolePredicate = state.currentRoleId
        ? eq(players.roleId, state.currentRoleId)
        : isNull(players.roleId);
      const [updated] = await tx
        .update(players)
        .set({
          roleId: afterRoleId,
          roleExpiresAt: null,
          roleComment: null,
          updatedAt: now,
        })
        .where(and(eq(players.id, state.playerId), currentRolePredicate))
        .returning({ id: players.id });
      if (!updated) continue;

      await tx.insert(auditLog).values({
        actorKind: 'system',
        actorPlayerId: null,
        actorTokenId: null,
        actorSystemLabel: 'seed-reward',
        actorIp: null,
        actionType: kind === 'granted' ? 'seed.reward_granted' : 'seed.reward_revoked',
        targetType: 'player',
        targetId: state.playerId,
        beforeSnapshot: {
          role_id: state.currentRoleId,
          role_expires_at: state.roleExpiresAt?.toISOString() ?? null,
          role_comment: state.roleComment,
        },
        afterSnapshot: { role_id: afterRoleId, role_expires_at: null, role_comment: null },
        context: {
          reward_role_id: rewardRoleId,
          seed_seconds: seedSeconds,
          threshold_seconds: thresholdSeconds,
          from_day: window.fromDay,
          to_day: window.toDay,
        },
        statusCode: 200,
        rowHash: Buffer.from([]),
      });
      changes.push({
        kind,
        playerId: state.playerId,
        beforeRoleId: state.currentRoleId,
        afterRoleId,
        seedSeconds,
      });
    }

    return { configured: true, ...window, rewardRoleId, thresholdSeconds, changes };
  });
}

export async function revokeAllSessionsForPlayer(
  db: DatabaseClient,
  redis: Pick<Redis, 'del'>,
  playerId: string,
): Promise<void> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.playerId, playerId));
  if (rows.length === 0) return;
  await db.delete(sessions).where(eq(sessions.playerId, playerId));
  await redis.del(...rows.map((row) => `session:${row.id}`));
}

export async function publishAdminsCfgSyncForAllServers(
  db: Pick<DatabaseClient, 'select'>,
  redis: Pick<Redis, 'pipeline'>,
  event: SeedRewardSyncEvent,
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
