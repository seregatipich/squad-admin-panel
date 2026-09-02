import { and, eq, isNotNull } from 'drizzle-orm';
import type { DatabaseClient } from '../client.js';
import { type BonusTransactionRow, bonusTransactions } from '../schema/bonus-transactions.js';
import { players } from '../schema/players.js';
import { vipLifecycleEvents } from '../schema/vip-lifecycle-events.js';

const DAY_MS = 86_400_000;

/**
 * The subset of the drizzle client this module needs. Both `app.db` and a
 * `db.transaction()` handle satisfy it structurally, so the API and the
 * worker can call the same code inside their own transaction (precedent:
 * `publishAdminsCfgSyncForAllServers`).
 */
export type VipGrantExecutor = Pick<DatabaseClient, 'select' | 'insert' | 'update'>;

/** The purchasable shape of a VIP tier, already resolved and priced. */
export interface VipGrantTier {
  /** RBAC role the tier grants. */
  roleId: string;
  /** Length of one paid period, in days. */
  days: number;
  /** Bonus-point price of one period; `0` is a valid free grant. */
  price: number;
}

/** The buyer's state, read under `FOR UPDATE` before the decision is made. */
export interface VipGrantTargetState {
  balance: number;
  roleId: string | null;
  roleExpiresAt: Date | null;
  externalLifecycleOwner?: boolean;
}

export type VipGrantPlan =
  | {
      status: 'ok';
      price: number;
      nextBalance: number;
      roleId: string;
      roleExpiresAt: Date;
    }
  | { status: 'insufficient_balance'; balance: number }
  | { status: 'role_conflict' }
  | { status: 'role_permanent' };

/**
 * Decides whether a VIP tier can be charged to `state` and what the resulting
 * balance and role expiry would be. Pure — no I/O — so the rules that matter
 * (balance floor, role collisions, "extend from the later of now and the
 * current expiry") are testable without a database and are shared by the
 * privilege shop (ECON-6), self-service purchases and the subscription
 * renewal tick (VIPSUB-5).
 *
 * @param state buyer's balance and current role assignment
 * @param tier resolved tier: role, period length and price
 * @param now reference clock
 * @returns an applicable plan, or the reason the grant is refused
 */
export function planVipGrant(
  state: VipGrantTargetState,
  tier: VipGrantTier,
  now: Date,
): VipGrantPlan {
  const nextBalance = state.balance - tier.price;
  if (nextBalance < 0) return { status: 'insufficient_balance', balance: state.balance };
  if (state.externalLifecycleOwner) return { status: 'role_conflict' };

  const sameRole = state.roleId === tier.roleId;
  if (state.roleId !== null && !sameRole) return { status: 'role_conflict' };
  if (sameRole && state.roleExpiresAt === null) return { status: 'role_permanent' };

  const base =
    sameRole && state.roleExpiresAt !== null && state.roleExpiresAt > now
      ? state.roleExpiresAt
      : now;

  return {
    status: 'ok',
    price: tier.price,
    nextBalance,
    roleId: tier.roleId,
    roleExpiresAt: new Date(base.getTime() + tier.days * DAY_MS),
  };
}

export interface VipLifecycleProjection {
  id: string;
  roleId: string | null;
  roleExpiresAt: Date | null;
  roleComment: string | null;
  roleLifecycleEventId: string | null;
}

export interface VipLifecycleOwner {
  purchaseId: string | null;
  expiresAt: Date;
}

export function vipLifecycleRoleComment(tier: string | null, purchaseId: string | null): string {
  const purchase = purchaseId ? ` purchase ${purchaseId}` : '';
  return `VIP ${tier ?? 'vip'}${purchase}`;
}

/** Returns evidence only while the player projection points at its exact external grant. */
export async function findVipLifecycleOwner(
  tx: Pick<DatabaseClient, 'select'>,
  player: VipLifecycleProjection,
  expectedPurchaseId?: string | null,
): Promise<VipLifecycleOwner | null> {
  if (!player.roleId || !player.roleExpiresAt || !player.roleLifecycleEventId) return null;
  const [event] = await tx
    .select({
      purchaseId: vipLifecycleEvents.purchaseId,
      tier: vipLifecycleEvents.tier,
      payload: vipLifecycleEvents.payload,
    })
    .from(vipLifecycleEvents)
    .where(
      and(
        eq(vipLifecycleEvents.playerId, player.id),
        eq(vipLifecycleEvents.eventId, player.roleLifecycleEventId),
        eq(vipLifecycleEvents.roleId, player.roleId),
        eq(vipLifecycleEvents.action, 'assigned'),
        isNotNull(vipLifecycleEvents.appliedAt),
      ),
    )
    .limit(1);
  if (!event || (expectedPurchaseId !== undefined && event.purchaseId !== expectedPurchaseId)) {
    return null;
  }
  const payload = event.payload as { expires_at?: unknown };
  if (typeof payload.expires_at !== 'string') return null;
  const expiresAt = new Date(payload.expires_at);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() !== player.roleExpiresAt.getTime() ||
    vipLifecycleRoleComment(event.tier, event.purchaseId) !== player.roleComment
  ) {
    return null;
  }
  return { purchaseId: event.purchaseId, expiresAt };
}

/**
 * Advances a subscription's billing date by one period.
 *
 * Anchored on the date that was due, not on the wall clock, so a worker
 * outage does not silently shift every subsequent renewal — the tick simply
 * catches up one period per pass.
 *
 * @param dueAt the `next_renewal_at` that just came due
 * @param days period length in days
 */
export function nextRenewalAfter(dueAt: Date, days: number): Date {
  return new Date(dueAt.getTime() + days * DAY_MS);
}

export interface ApplyVipGrantInput {
  playerId: string;
  tier: VipGrantTier;
  /** Ledger actor; `null` for machine-driven renewals. */
  actorPlayerId: string | null;
  /** `bonus_transactions.reference_type`, e.g. `purchase` or `vip_subscription`. */
  referenceType: string;
  /** `bonus_transactions.reference_id`, e.g. the tier id or the subscription id. */
  referenceId: string;
  now?: Date;
}

export type ApplyVipGrantResult =
  | {
      status: 'ok';
      balance: number;
      roleId: string;
      roleExpiresAt: Date;
      /** `null` for a free tier — `bonus_transactions_amount_nonzero_chk` forbids a 0 row. */
      transaction: BonusTransactionRow | null;
    }
  | { status: 'player_not_found' }
  | { status: 'insufficient_balance'; balance: number }
  | { status: 'role_conflict' }
  | { status: 'role_permanent' };

/**
 * Charges a VIP tier to a player and grants the matching timed role, inside
 * the caller's transaction.
 *
 * Locks the player row `FOR UPDATE`, applies {@link planVipGrant}, then writes
 * the `spend` ledger row and the new `bonus_balance`/`role_id`/
 * `role_expires_at` in one shot. The caller remains responsible for anything
 * outside the ledger: the tier lookup and its escalation guard, the
 * `economy_enabled` check, the Admins.cfg sync fan-out, the permission-cache
 * invalidation and the audit row.
 *
 * @param tx an open transaction (or the db handle) — see {@link VipGrantExecutor}
 * @param input target player, resolved tier and ledger reference
 * @returns the applied outcome, or the reason the grant was refused
 */
export async function applyVipGrant(
  tx: VipGrantExecutor,
  input: ApplyVipGrantInput,
): Promise<ApplyVipGrantResult> {
  const now = input.now ?? new Date();
  const locked = await tx
    .select({
      id: players.id,
      balance: players.bonusBalance,
      roleId: players.roleId,
      roleExpiresAt: players.roleExpiresAt,
      roleComment: players.roleComment,
      roleLifecycleEventId: players.roleLifecycleEventId,
    })
    .from(players)
    .where(eq(players.id, input.playerId))
    .for('update')
    .limit(1);
  const current = locked[0];
  if (!current) return { status: 'player_not_found' };

  const externalLifecycleOwner = await findVipLifecycleOwner(tx, current);
  const plan = planVipGrant(
    { ...current, externalLifecycleOwner: externalLifecycleOwner !== null },
    input.tier,
    now,
  );
  if (plan.status !== 'ok') return plan;

  let transaction: BonusTransactionRow | null = null;
  if (plan.price !== 0) {
    const inserted = await tx
      .insert(bonusTransactions)
      .values({
        playerId: input.playerId,
        amount: -plan.price,
        type: 'spend',
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        actorPlayerId: input.actorPlayerId,
      })
      .returning();
    transaction = inserted[0] ?? null;
    if (!transaction) throw new Error('bonus_transactions insert returned no row');
  }

  await tx
    .update(players)
    .set({
      bonusBalance: plan.nextBalance,
      roleId: plan.roleId,
      roleExpiresAt: plan.roleExpiresAt,
      roleComment: null,
      roleLifecycleEventId: null,
      updatedAt: now,
    })
    .where(eq(players.id, input.playerId));

  return {
    status: 'ok',
    balance: plan.nextBalance,
    roleId: plan.roleId,
    roleExpiresAt: plan.roleExpiresAt,
    transaction,
  };
}
