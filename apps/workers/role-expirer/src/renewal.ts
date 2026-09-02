import {
  applyVipGrant,
  type DatabaseClient,
  enqueueAdminsCfgSyncForAllServers,
  nextRenewalAfter,
} from '@squad/db';
import {
  alertEvents,
  auditLog,
  players,
  ROLE_EXPIRY_ALERT_RULE_ID,
  vipSubscriptions,
  vipTiers,
} from '@squad/db/schema';
import type { Diag } from '@squad/diag';
import { and, asc, eq, lte } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { AdminsCfgSyncEvent } from './tick.js';

/** Redis pub/sub channel the API's live-bus subscribes to for real-time fan-out. */
const LIVE_BUS_CHANNEL = 'live-bus';

/** An active subscription whose `next_renewal_at` has come due. */
export interface DueSubscription {
  id: string;
  playerId: string;
  playerName: string;
  tierId: string;
  tierName: string;
  /** Read from the tier, not the subscription: the role a tier maps to may be re-pointed. */
  roleId: string;
  /** Snapshot price — never re-read from the catalog. */
  priceBonuses: number;
  /** Snapshot period — never re-read from the catalog. */
  renewsEveryDays: number;
  nextRenewalAt: Date;
}

/** Why a subscription could not be renewed and was therefore ended. */
export type RenewalFailureReason =
  | 'insufficient_balance'
  | 'role_conflict'
  | 'role_permanent'
  | 'player_not_found';

export interface ChargeRenewalInput {
  subscriptionId: string;
  playerId: string;
  roleId: string;
  price: number;
  days: number;
  /** The billing date to store once the charge succeeds. */
  nextRenewalAt: Date;
  now: Date;
  syncEvent: AdminsCfgSyncEvent;
}

export type ChargeRenewalResult =
  | { status: 'ok'; balance: number; roleExpiresAt: Date; enqueued: number }
  | { status: 'insufficient_balance'; balance: number }
  | { status: 'role_conflict' }
  | { status: 'role_permanent' }
  | { status: 'player_not_found' }
  /** Cancelled between the scan and the charge — nothing was billed. */
  | { status: 'not_active' };

/**
 * Live-bus / `alert_events` payload for a subscription that could not be
 * renewed. Deliberately carried on the seeded `role_expiring` alert rule with
 * its own `event_kind` discriminator rather than a new `alert_rules.type`,
 * which would need `alert_rules_type_chk` widened.
 */
export interface SubscriptionExpiredAlertPayload {
  event_kind: 'subscription_expired';
  player_id: string;
  player_name: string;
  subscription_id: string;
  tier_id: string;
  tier_name: string;
  reason: RenewalFailureReason;
  price_bonuses: number;
  /** Balance at the moment of failure; `null` when the balance was not the cause. */
  balance: number | null;
}

export interface SubscriptionAuditEntry {
  actor: { kind: 'system'; label: 'role-expirer' };
  actorIp: null;
  actionType: 'player.subscription.renew' | 'player.subscription.expire';
  targetType: 'player';
  targetId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  context: Record<string, unknown>;
  statusCode: 200;
}

export interface SubscriptionRenewalDeps {
  now?: Date;
  findDueSubscriptions(now: Date): Promise<DueSubscription[]>;
  chargeRenewal(input: ChargeRenewalInput): Promise<ChargeRenewalResult>;
  expireSubscription(subscriptionId: string, now: Date): Promise<void>;
  writeAuditEntry(entry: SubscriptionAuditEntry): Promise<void>;
  notifySubscriptionExpired(payload: SubscriptionExpiredAlertPayload): Promise<void>;
  invalidatePermissionCache(playerId: string): void;
  diag: Pick<Diag, 'emit'>;
}

export interface SubscriptionRenewalResult {
  renewed: number;
  expired: number;
  enqueued: number;
}

/**
 * VIPSUB-5 (#171) subscription renewal pass.
 *
 * For every active subscription whose `next_renewal_at` has come due, charges
 * the snapshot price against the player's bonus balance and pushes both
 * `players.role_expires_at` and `next_renewal_at` forward by one period. A
 * subscription that cannot be charged — short balance, or a role collision
 * that makes the grant impossible — flips to `expired` and the player is
 * notified; its role is NOT removed here, because the already-paid period must
 * run out first, which the existing `runRoleExpiryTick` handles on schedule.
 *
 * One failing subscription never aborts the batch. Every successful renewal
 * writes its Admins.cfg outbox rows in the same transaction as the charge.
 */
export async function runSubscriptionRenewalTick(
  deps: SubscriptionRenewalDeps,
): Promise<SubscriptionRenewalResult> {
  const now = deps.now ?? new Date();
  try {
    const due = await deps.findDueSubscriptions(now);
    let renewed = 0;
    let expired = 0;
    let enqueued = 0;
    const syncEvent: AdminsCfgSyncEvent = {
      reason: 'player.role.assign',
      actor_player_id: null,
      enqueued_at: now.toISOString(),
      request_id: `role-expirer:renewals:${now.toISOString()}`,
    };

    for (const subscription of due) {
      const result = await deps.chargeRenewal({
        subscriptionId: subscription.id,
        playerId: subscription.playerId,
        roleId: subscription.roleId,
        price: subscription.priceBonuses,
        days: subscription.renewsEveryDays,
        nextRenewalAt: nextRenewalAfter(subscription.nextRenewalAt, subscription.renewsEveryDays),
        now,
        syncEvent,
      });

      // Cancelled while the batch was in flight: nothing was billed and the
      // row is no longer ours to touch.
      if (result.status === 'not_active') continue;

      if (result.status === 'ok') {
        renewed += 1;
        enqueued += result.enqueued;
        await deps.writeAuditEntry({
          actor: { kind: 'system', label: 'role-expirer' },
          actorIp: null,
          actionType: 'player.subscription.renew',
          targetType: 'player',
          targetId: subscription.playerId,
          before: {
            next_renewal_at: subscription.nextRenewalAt.toISOString(),
          },
          after: {
            next_renewal_at: nextRenewalAfter(
              subscription.nextRenewalAt,
              subscription.renewsEveryDays,
            ).toISOString(),
            role_expires_at: result.roleExpiresAt.toISOString(),
            bonus_balance: result.balance,
          },
          context: {
            subscription_id: subscription.id,
            tier_id: subscription.tierId,
            price_bonuses: subscription.priceBonuses,
            renewed_at: now.toISOString(),
          },
          statusCode: 200,
        });
        deps.invalidatePermissionCache(subscription.playerId);
        continue;
      }

      expired += 1;
      const reason: RenewalFailureReason = result.status;
      await deps.expireSubscription(subscription.id, now);
      await deps.writeAuditEntry({
        actor: { kind: 'system', label: 'role-expirer' },
        actorIp: null,
        actionType: 'player.subscription.expire',
        targetType: 'player',
        targetId: subscription.playerId,
        before: { status: 'active' },
        after: { status: 'expired' },
        context: {
          subscription_id: subscription.id,
          tier_id: subscription.tierId,
          reason,
          price_bonuses: subscription.priceBonuses,
          expired_at: now.toISOString(),
        },
        statusCode: 200,
      });
      await deps.notifySubscriptionExpired({
        event_kind: 'subscription_expired',
        player_id: subscription.playerId,
        player_name: subscription.playerName,
        subscription_id: subscription.id,
        tier_id: subscription.tierId,
        tier_name: subscription.tierName,
        reason,
        price_bonuses: subscription.priceBonuses,
        balance: result.status === 'insufficient_balance' ? result.balance : null,
      });
    }

    await deps.diag.emit({
      component: 'worker-role-expirer',
      kind: 'role_expirer.renewals_ok',
      severity: 'info',
      message: `renewed ${renewed} subscription(s), expired ${expired}`,
      payload: { renewed, expired, enqueued },
    });

    return { renewed, expired, enqueued };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.diag.emit({
      component: 'worker-role-expirer',
      kind: 'role_expirer.renewals_failed',
      severity: 'error',
      message: `subscription renewal failed: ${message}`,
      payload: { err: message },
    });
    throw err;
  }
}

export function createSubscriptionRenewalDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'publish'>,
  opts: { batchSize?: number } = {},
): Omit<SubscriptionRenewalDeps, 'now' | 'diag'> {
  const batchSize = opts.batchSize ?? 500;
  return {
    findDueSubscriptions: (now) => findDueSubscriptions(db, now, batchSize),
    chargeRenewal: (input) => chargeRenewal(db, input),
    expireSubscription: (subscriptionId, now) => expireSubscription(db, subscriptionId, now),
    writeAuditEntry: (entry) => writeSubscriptionAuditEntry(db, entry),
    notifySubscriptionExpired: (payload) => notifySubscriptionExpired(db, redis, payload),
    invalidatePermissionCache: () => undefined,
  };
}

export async function findDueSubscriptions(
  db: DatabaseClient,
  now: Date,
  limit: number,
): Promise<DueSubscription[]> {
  const rows = await db
    .select({
      id: vipSubscriptions.id,
      playerId: vipSubscriptions.playerId,
      playerName: players.canonicalName,
      tierId: vipSubscriptions.tierId,
      tierName: vipTiers.name,
      roleId: vipTiers.roleId,
      priceBonuses: vipSubscriptions.priceBonuses,
      renewsEveryDays: vipSubscriptions.renewsEveryDays,
      nextRenewalAt: vipSubscriptions.nextRenewalAt,
    })
    .from(vipSubscriptions)
    .innerJoin(players, eq(players.id, vipSubscriptions.playerId))
    .innerJoin(vipTiers, eq(vipTiers.id, vipSubscriptions.tierId))
    .where(and(eq(vipSubscriptions.status, 'active'), lte(vipSubscriptions.nextRenewalAt, now)))
    .orderBy(asc(vipSubscriptions.nextRenewalAt))
    .limit(limit);
  return rows;
}

/**
 * Charges one period and moves the billing date, atomically. Re-checks that the
 * subscription is still `active` and still due inside the transaction, so a
 * cancellation racing the tick cannot be billed.
 */
export async function chargeRenewal(
  db: DatabaseClient,
  input: ChargeRenewalInput,
): Promise<ChargeRenewalResult> {
  try {
    return await chargeRenewalTx(db, input);
  } catch (err) {
    if (err instanceof SubscriptionVanishedError) return { status: 'not_active' };
    throw err;
  }
}

async function chargeRenewalTx(
  db: DatabaseClient,
  input: ChargeRenewalInput,
): Promise<ChargeRenewalResult> {
  return db.transaction(async (tx) => {
    const applied = await applyVipGrant(tx, {
      playerId: input.playerId,
      tier: { roleId: input.roleId, days: input.days, price: input.price },
      actorPlayerId: null,
      referenceType: 'vip_subscription',
      referenceId: input.subscriptionId,
      now: input.now,
    });
    if (applied.status !== 'ok') return applied;

    const updated = await tx
      .update(vipSubscriptions)
      .set({ nextRenewalAt: input.nextRenewalAt })
      .where(
        and(eq(vipSubscriptions.id, input.subscriptionId), eq(vipSubscriptions.status, 'active')),
      )
      .returning({ id: vipSubscriptions.id });
    if (!updated[0]) {
      // Cancelled between the scan and the charge — undo the whole period.
      throw new SubscriptionVanishedError(input.subscriptionId);
    }
    const { enqueued } = await enqueueAdminsCfgSyncForAllServers(tx, input.syncEvent);

    return {
      status: 'ok' as const,
      balance: applied.balance,
      roleExpiresAt: applied.roleExpiresAt,
      enqueued,
    };
  });
}

/** Raised to roll back a charge for a subscription that stopped being active. */
export class SubscriptionVanishedError extends Error {
  constructor(subscriptionId: string) {
    super(`subscription ${subscriptionId} is no longer active`);
    this.name = 'SubscriptionVanishedError';
  }
}

export async function expireSubscription(
  db: DatabaseClient,
  subscriptionId: string,
  now: Date,
): Promise<void> {
  await db
    .update(vipSubscriptions)
    .set({ status: 'expired', cancelledAt: now })
    .where(and(eq(vipSubscriptions.id, subscriptionId), eq(vipSubscriptions.status, 'active')));
}

export async function writeSubscriptionAuditEntry(
  db: DatabaseClient,
  entry: SubscriptionAuditEntry,
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
 * Records the failure as a broadcast `alert_events` row on the seeded VIPSUB-4
 * `role_expiring` rule and pushes the matching live-bus frame. The API filters
 * `subscription_expired` frames to sockets holding `can_assign_roles`
 * (`apps/api/src/routes/live.ts`); the player themselves sees the `expired`
 * status on their self-service page.
 */
export async function notifySubscriptionExpired(
  db: DatabaseClient,
  redis: Pick<Redis, 'publish'>,
  payload: SubscriptionExpiredAlertPayload,
): Promise<void> {
  await db
    .insert(alertEvents)
    .values({ ruleId: ROLE_EXPIRY_ALERT_RULE_ID, severity: 'warning', payload });
  await redis.publish(
    LIVE_BUS_CHANNEL,
    JSON.stringify({ type: 'alert.triggered', ts: new Date().toISOString(), data: payload }),
  );
}
