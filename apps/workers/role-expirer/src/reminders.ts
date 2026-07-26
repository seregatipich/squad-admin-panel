import type { DatabaseClient } from '@squad/db';
import {
  alertEvents,
  type ExpiryNotificationRecipient,
  economySettings,
  expiryNotifications,
  players,
  ROLE_EXPIRY_ALERT_RULE_ID,
  roles,
} from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { and, asc, eq, gt, isNotNull, lte } from 'drizzle-orm';
import type Redis from 'ioredis';

/** Redis pub/sub channel the API's live-bus subscribes to for real-time fan-out. */
const LIVE_BUS_CHANNEL = 'live-bus';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOWS_DAYS = [7, 3, 1];
const WINDOW_DAYS_MIN = 1;
const WINDOW_DAYS_MAX = 90;

export interface ExpiringGrant {
  playerId: string;
  playerName: string;
  roleId: string;
  roleName: string;
  roleExpiresAt: Date;
}

export interface ExpiryNotificationClaim {
  playerId: string;
  roleId: string;
  expiresAt: Date;
  windowDays: number;
  recipient: ExpiryNotificationRecipient;
}

export interface RoleExpiryAlertPayload {
  event_kind: 'role_expiring';
  player_id: string;
  player_name: string;
  role_id: string;
  role_name: string;
  expires_at: string;
  window_days: number;
}

export interface RoleExpiryReminderDeps {
  now?: Date;
  loadReminderWindows(): Promise<number[]>;
  findExpiringGrants(now: Date, maxWindowDays: number): Promise<ExpiringGrant[]>;
  /**
   * Dedup insert into `expiry_notifications` (ON CONFLICT DO NOTHING
   * RETURNING). `null` means the (player, role, expires_at, window, recipient)
   * key was already claimed by an earlier tick — nothing must be emitted.
   */
  claimNotification(claim: ExpiryNotificationClaim): Promise<{ id: string } | null>;
  insertAlertEvent(input: {
    ruleId: string;
    payload: RoleExpiryAlertPayload;
  }): Promise<{ id: string }>;
  linkAlertEvent(notificationId: string, alertEventId: string): Promise<void>;
  publishAlertFrame(payload: RoleExpiryAlertPayload): Promise<void>;
  diag: Pick<Diag, 'emit'>;
}

export interface RoleExpiryReminderResult {
  notified: number;
}

/**
 * Sanitizes configured reminder windows: integers within [1, 90], deduped,
 * sorted descending so the smallest crossed window is the last match.
 */
function normalizeWindows(windows: number[]): number[] {
  const valid = windows.filter(
    (w) => Number.isInteger(w) && w >= WINDOW_DAYS_MIN && w <= WINDOW_DAYS_MAX,
  );
  return [...new Set(valid)].sort((a, b) => b - a);
}

/**
 * Daily VIPSUB-4 reminder pass. For every active time-limited grant inside a
 * configured window it fires the SMALLEST crossed window exactly once per
 * (player, role, expires_at, window): one broadcast `alert_events` row + one
 * live-bus `alert.triggered` frame for admins (audience filtered at read/fan-out
 * time by `can_assign_roles`), plus a pending `player` dedup row that log-ingest
 * turns into a one-shot in-game AdminWarn on the player's next connect. Re-runs
 * are no-ops (dedup claim conflicts); a renewed grant re-arms mechanically
 * because `expires_at` is part of the dedup key.
 */
export async function runRoleExpiryReminderTick(
  deps: RoleExpiryReminderDeps,
): Promise<RoleExpiryReminderResult> {
  const now = deps.now ?? new Date();
  try {
    const windows = normalizeWindows(await deps.loadReminderWindows());
    let notified = 0;
    if (windows.length > 0) {
      const maxWindow = windows[0] as number;
      const grants = await deps.findExpiringGrants(now, maxWindow);
      for (const grant of grants) {
        const msLeft = grant.roleExpiresAt.getTime() - now.getTime();
        if (msLeft <= 0) continue;
        const daysLeft = msLeft / DAY_MS;
        const crossed = windows.filter((w) => daysLeft <= w);
        if (crossed.length === 0) continue;
        const windowDays = crossed[crossed.length - 1] as number;

        const claim = {
          playerId: grant.playerId,
          roleId: grant.roleId,
          expiresAt: grant.roleExpiresAt,
          windowDays,
        };
        const adminClaim = await deps.claimNotification({ ...claim, recipient: 'admin' });
        if (adminClaim) {
          const payload: RoleExpiryAlertPayload = {
            event_kind: 'role_expiring',
            player_id: grant.playerId,
            player_name: grant.playerName,
            role_id: grant.roleId,
            role_name: grant.roleName,
            expires_at: grant.roleExpiresAt.toISOString(),
            window_days: windowDays,
          };
          const alertEvent = await deps.insertAlertEvent({
            ruleId: ROLE_EXPIRY_ALERT_RULE_ID,
            payload,
          });
          await deps.linkAlertEvent(adminClaim.id, alertEvent.id);
          await deps.publishAlertFrame(payload);
          notified++;
        }
        await deps.claimNotification({ ...claim, recipient: 'player' });
      }
    }

    await deps.diag.emit({
      component: 'worker-role-expirer',
      kind: 'role_expirer.reminders_ok',
      severity: 'info',
      message: `sent ${notified} VIP expiry reminder(s)`,
      payload: { notified, windows },
    });
    return { notified };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.diag.emit({
      component: 'worker-role-expirer',
      kind: 'role_expirer.reminders_failed',
      severity: 'error',
      message: `VIP expiry reminders failed: ${message}`,
      payload: { err: message },
    });
    throw err;
  }
}

export function createRoleExpiryReminderDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'publish'>,
  opts: { batchSize?: number } = {},
): Omit<RoleExpiryReminderDeps, 'now' | 'diag'> {
  const batchSize = opts.batchSize ?? 1000;
  return {
    loadReminderWindows: () => loadReminderWindows(db),
    findExpiringGrants: (now, maxWindowDays) =>
      findExpiringGrants(db, now, maxWindowDays, batchSize),
    claimNotification: (claim) => claimExpiryNotification(db, claim),
    insertAlertEvent: async (input) => {
      const rows = await db
        .insert(alertEvents)
        .values({ ruleId: input.ruleId, severity: 'info', payload: input.payload })
        .returning({ id: alertEvents.id });
      const row = rows[0];
      if (!row) throw new Error('alert_events insert returned no row');
      return row;
    },
    linkAlertEvent: async (notificationId, alertEventId) => {
      await db
        .update(expiryNotifications)
        .set({ alertEventId })
        .where(eq(expiryNotifications.id, notificationId));
    },
    publishAlertFrame: async (payload) => {
      await redis.publish(
        LIVE_BUS_CHANNEL,
        JSON.stringify({ type: 'alert.triggered', ts: new Date().toISOString(), data: payload }),
      );
    },
  };
}

export async function loadReminderWindows(db: DatabaseClient): Promise<number[]> {
  const rows = await db
    .select({ windows: economySettings.vipExpiryWindowsDays })
    .from(economySettings)
    .where(eq(economySettings.id, 1))
    .limit(1);
  const windows = rows[0]?.windows;
  return Array.isArray(windows) ? windows : DEFAULT_WINDOWS_DAYS;
}

export async function findExpiringGrants(
  db: DatabaseClient,
  now: Date,
  maxWindowDays: number,
  limit: number,
): Promise<ExpiringGrant[]> {
  const horizon = new Date(now.getTime() + maxWindowDays * DAY_MS);
  const rows = await db
    .select({
      playerId: players.id,
      playerName: players.canonicalName,
      roleId: players.roleId,
      roleName: roles.name,
      roleExpiresAt: players.roleExpiresAt,
    })
    .from(players)
    .innerJoin(roles, eq(players.roleId, roles.id))
    .where(
      and(
        isNotNull(players.roleId),
        isNotNull(players.roleExpiresAt),
        gt(players.roleExpiresAt, now),
        lte(players.roleExpiresAt, horizon),
      ),
    )
    .orderBy(asc(players.roleExpiresAt))
    .limit(limit);

  return rows.flatMap((row) => {
    if (!row.roleId || !row.roleExpiresAt) return [];
    return [
      {
        playerId: row.playerId,
        playerName: row.playerName,
        roleId: row.roleId,
        roleName: row.roleName,
        roleExpiresAt: row.roleExpiresAt,
      },
    ];
  });
}

export async function claimExpiryNotification(
  db: DatabaseClient,
  claim: ExpiryNotificationClaim,
): Promise<{ id: string } | null> {
  const rows = await db
    .insert(expiryNotifications)
    .values({
      playerId: claim.playerId,
      roleId: claim.roleId,
      expiresAt: claim.expiresAt,
      windowDays: claim.windowDays,
      recipient: claim.recipient,
    })
    .onConflictDoNothing({
      target: [
        expiryNotifications.playerId,
        expiryNotifications.roleId,
        expiryNotifications.expiresAt,
        expiryNotifications.windowDays,
        expiryNotifications.recipient,
      ],
    })
    .returning({ id: expiryNotifications.id });
  return rows[0] ?? null;
}
