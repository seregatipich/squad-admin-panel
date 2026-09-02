import { type ApplyVipGrantResult, applyVipGrant } from '@squad/db';
import {
  bonusTransactions,
  economySettings,
  players,
  roles,
  type VipSubscriptionRow,
  vipSubscriptions,
  vipTiers,
} from '@squad/db/schema';
import { and, asc, desc, eq, isNotNull, lt } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { invalidatePermissionCache } from '../lib/rbac.js';

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_PERIOD_DAYS = 3650;
const INT32_MAX = 2_147_483_647;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const subscriptionIdParams = z.object({ id: z.string().uuid() });
const tierBody = z.object({ tier_id: z.string().uuid() });
const grantBody = z.object({
  tier_id: z.string().uuid(),
  renews_every_days: z.number().int().min(1).max(MAX_PERIOD_DAYS).optional(),
  price_bonuses: z.number().int().min(0).max(INT32_MAX).optional(),
});
const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  before: z.coerce.number().int().positive().optional(),
});

/**
 * A tier resolved for purchase: priced, timed, and safe to grant. The refusal
 * reasons mirror ECON-6 (`apps/api/src/routes/economy.ts`) exactly, including
 * its escalation guard — bonus points must never buy a role that opens the
 * panel or a system role.
 */
type ResolvedTier =
  | { ok: true; roleId: string; days: number; price: number; name: string }
  | { ok: false; reason: 'tier_not_found' | 'tier_not_purchasable' | 'role_grants_panel_access' };

function serialize(row: VipSubscriptionRow, tierName?: string | null) {
  return {
    id: row.id,
    player_id: row.playerId,
    tier_id: row.tierId,
    ...(tierName === undefined ? {} : { tier_name: tierName }),
    status: row.status,
    renews_every_days: row.renewsEveryDays,
    price_bonuses: row.priceBonuses,
    next_renewal_at: row.nextRenewalAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    cancelled_at: row.cancelledAt ? row.cancelledAt.toISOString() : null,
  };
}

const vipSubscriptionRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Resolves the subject of a self-service route. There is no path parameter to
   * check: the subject is always the session's own player.
   */
  function selfGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
    if (!req.user) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    return null;
  }

  function selfPlayerId(req: FastifyRequest): string {
    // biome-ignore lint/style/noNonNullAssertion: callers run selfGuard first
    return req.user!.playerId;
  }

  function panelGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
    if (!req.user) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    if (!req.user.permissions.panelAccess) {
      reply.code(403);
      return { error: 'forbidden' };
    }
    return null;
  }

  /**
   * Admin grant guard. Mirrors `purchaseGuard` in `economy.ts`: the operation
   * spends the ledger AND grants an RBAC role, so `can_manage_economy` alone
   * would let an economy manager route around the role-assignment permission.
   */
  function grantGuard(
    req: FastifyRequest,
    reply: FastifyReply,
  ): { error: string; required?: string } | null {
    if (!req.user) {
      reply.code(401);
      return { error: 'unauthenticated' };
    }
    if (!req.user.permissions.canManageEconomy) {
      reply.code(403);
      return { error: 'forbidden', required: 'can_manage_economy' };
    }
    if (!req.user.permissions.canAssignRoles) {
      reply.code(403);
      return { error: 'forbidden', required: 'can_assign_roles' };
    }
    return null;
  }

  async function economyEnabled(): Promise<boolean> {
    const [row] = await app.db
      .select({ enabled: economySettings.economyEnabled })
      .from(economySettings)
      .limit(1);
    return row?.enabled ?? false;
  }

  async function resolveTier(tierId: string): Promise<ResolvedTier> {
    const [tier] = await app.db
      .select({
        name: vipTiers.name,
        roleId: vipTiers.roleId,
        defaultDays: vipTiers.defaultDays,
        priceBonuses: vipTiers.priceBonuses,
        rolePanelAccess: roles.panelAccess,
        roleIsSystem: roles.isSystemRole,
      })
      .from(vipTiers)
      .innerJoin(roles, eq(roles.id, vipTiers.roleId))
      .where(eq(vipTiers.id, tierId))
      .limit(1);
    if (!tier) return { ok: false, reason: 'tier_not_found' };
    if (tier.priceBonuses == null || tier.defaultDays == null) {
      return { ok: false, reason: 'tier_not_purchasable' };
    }
    if (tier.rolePanelAccess || tier.roleIsSystem) {
      return { ok: false, reason: 'role_grants_panel_access' };
    }
    return {
      ok: true,
      name: tier.name,
      roleId: tier.roleId,
      days: tier.defaultDays,
      price: tier.priceBonuses,
    };
  }

  const TIER_PROBLEM_STATUS: Record<Exclude<ResolvedTier, { ok: true }>['reason'], number> = {
    tier_not_found: 404,
    tier_not_purchasable: 409,
    role_grants_panel_access: 403,
  };

  function replyTierProblem(
    reply: FastifyReply,
    reason: Exclude<ResolvedTier, { ok: true }>['reason'],
  ) {
    reply.code(TIER_PROBLEM_STATUS[reason]);
    return { error: reason };
  }

  function replyGrantProblem(reply: FastifyReply, outcome: ApplyVipGrantResult) {
    if (outcome.status === 'player_not_found') {
      reply.code(404);
      return { error: 'player_not_found' };
    }
    if (outcome.status === 'insufficient_balance') {
      reply.code(409);
      return { error: 'insufficient_balance', balance: outcome.balance };
    }
    reply.code(409);
    return { error: outcome.status };
  }

  // ---------------------------------------------------------------- self-service
  // Every route below is reachable by a `self_service` session (a Steam login
  // whose role has no `panel_access`) and therefore takes NO player id: the
  // subject is always `req.user.playerId`, which makes reading another
  // player's data structurally impossible rather than merely guarded.

  fast.get(
    '/api/v1/me/tiers',
    { config: { audit: false, selfService: true } },
    async (req, reply) => {
      const denied = selfGuard(req, reply);
      if (denied) return denied;
      const rows = await app.db
        .select({
          id: vipTiers.id,
          name: vipTiers.name,
          description: vipTiers.description,
          roleId: vipTiers.roleId,
          defaultDays: vipTiers.defaultDays,
          priceBonuses: vipTiers.priceBonuses,
          rolePanelAccess: roles.panelAccess,
          roleIsSystem: roles.isSystemRole,
        })
        .from(vipTiers)
        .innerJoin(roles, eq(roles.id, vipTiers.roleId))
        .where(and(eq(vipTiers.isActive, true), isNotNull(vipTiers.priceBonuses)))
        .orderBy(asc(vipTiers.sortOrder), asc(vipTiers.name));
      return {
        rows: rows
          .filter((r) => r.defaultDays != null && !r.rolePanelAccess && !r.roleIsSystem)
          .map((r) => ({
            tier_id: r.id,
            name: r.name,
            description: r.description,
            role_id: r.roleId,
            days: r.defaultDays,
            price_bonuses: r.priceBonuses,
          })),
      };
    },
  );

  fast.get(
    '/api/v1/me/bonus-balance',
    { config: { audit: false, selfService: true } },
    async (req, reply) => {
      const denied = selfGuard(req, reply);
      if (denied) return denied;
      const playerId = selfPlayerId(req);
      const rows = await app.db
        .select({
          balance: players.bonusBalance,
          roleId: players.roleId,
          roleExpiresAt: players.roleExpiresAt,
        })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      return {
        player_id: playerId,
        balance: row.balance,
        role_id: row.roleId,
        role_expires_at: row.roleExpiresAt ? row.roleExpiresAt.toISOString() : null,
      };
    },
  );

  fast.get(
    '/api/v1/me/bonus-transactions',
    { schema: { querystring: historyQuery }, config: { audit: false, selfService: true } },
    async (req, reply) => {
      const denied = selfGuard(req, reply);
      if (denied) return denied;
      const playerId = selfPlayerId(req);
      const limit = req.query.limit ?? DEFAULT_LIMIT;
      const conditions = [eq(bonusTransactions.playerId, playerId)];
      if (req.query.before !== undefined) {
        conditions.push(lt(bonusTransactions.id, BigInt(req.query.before)));
      }
      const rows = await app.db
        .select()
        .from(bonusTransactions)
        .where(and(...conditions))
        .orderBy(desc(bonusTransactions.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({
          id: Number(row.id),
          player_id: row.playerId,
          amount: row.amount,
          type: row.type,
          reference_type: row.referenceType,
          reference_id: row.referenceId,
          comment: row.comment,
          created_at: row.createdAt.toISOString(),
        })),
        next_cursor: hasMore && last ? Number(last.id) : null,
      };
    },
  );

  fast.get(
    '/api/v1/me/subscriptions',
    { config: { audit: false, selfService: true } },
    async (req, reply) => {
      const denied = selfGuard(req, reply);
      if (denied) return denied;
      const playerId = selfPlayerId(req);
      const rows = await app.db
        .select({ subscription: vipSubscriptions, tierName: vipTiers.name })
        .from(vipSubscriptions)
        .innerJoin(vipTiers, eq(vipTiers.id, vipSubscriptions.tierId))
        .where(eq(vipSubscriptions.playerId, playerId))
        .orderBy(desc(vipSubscriptions.createdAt));
      return { rows: rows.map((r) => serialize(r.subscription, r.tierName)) };
    },
  );

  fast.post(
    '/api/v1/me/purchases',
    {
      schema: { body: tierBody },
      config: {
        audit: { action: 'me.purchase.create', resource: 'player' },
        selfService: true,
      },
    },
    async (req, reply) => {
      const denied = selfGuard(req, reply);
      if (denied) return denied;
      const playerId = selfPlayerId(req);
      if (!(await economyEnabled())) {
        reply.code(409);
        return { error: 'economy_disabled' };
      }
      const tier = await resolveTier(req.body.tier_id);
      if (!tier.ok) return replyTierProblem(reply, tier.reason);

      const outcome = await app.db.transaction(async (tx) => {
        const applied = await applyVipGrant(tx, {
          playerId: playerId,
          tier: { roleId: tier.roleId, days: tier.days, price: tier.price },
          actorPlayerId: playerId,
          referenceType: 'purchase',
          referenceId: req.body.tier_id,
        });
        if (applied.status !== 'ok') return applied;
        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'player.role.assign',
          actor_player_id: playerId,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });
        return applied;
      });

      if (outcome.status !== 'ok') return replyGrantProblem(reply, outcome);
      invalidatePermissionCache(playerId);

      reply.code(201);
      return {
        ok: true,
        balance: outcome.balance,
        role_id: outcome.roleId,
        role_expires_at: outcome.roleExpiresAt.toISOString(),
      };
    },
  );

  fast.post(
    '/api/v1/me/subscriptions',
    {
      schema: { body: tierBody },
      config: {
        audit: { action: 'me.subscription.create', resource: 'player' },
        selfService: true,
      },
    },
    async (req, reply) => {
      const denied = selfGuard(req, reply);
      if (denied) return denied;
      const playerId = selfPlayerId(req);
      if (!(await economyEnabled())) {
        reply.code(409);
        return { error: 'economy_disabled' };
      }
      const tier = await resolveTier(req.body.tier_id);
      if (!tier.ok) return replyTierProblem(reply, tier.reason);

      const outcome = await createSubscription({
        playerId: playerId,
        tierId: req.body.tier_id,
        tier,
        actorPlayerId: playerId,
        requestId: req.id,
      });
      if (outcome.status === 'already_subscribed') {
        reply.code(409);
        return { error: 'already_subscribed' };
      }
      if (outcome.status !== 'ok') return replyGrantProblem(reply, outcome);
      invalidatePermissionCache(playerId);

      reply.code(201);
      return {
        balance: outcome.balance,
        role_expires_at: outcome.roleExpiresAt.toISOString(),
        subscription: serialize(outcome.subscription, tier.name),
      };
    },
  );

  fast.delete(
    '/api/v1/me/subscriptions/:id',
    {
      schema: { params: subscriptionIdParams },
      config: {
        audit: { action: 'me.subscription.cancel', resource: 'vip_subscription' },
        selfService: true,
      },
    },
    async (req, reply) => {
      const denied = selfGuard(req, reply);
      if (denied) return denied;
      const playerId = selfPlayerId(req);
      const now = new Date();
      // Cancelling never claws back the paid period: `players.role_id` and
      // `role_expires_at` are deliberately untouched, and the existing
      // role-expiry tick removes the role when the period runs out.
      const updated = await app.db
        .update(vipSubscriptions)
        .set({ status: 'cancelled', cancelledAt: now })
        .where(
          and(
            eq(vipSubscriptions.id, req.params.id),
            eq(vipSubscriptions.playerId, playerId),
            eq(vipSubscriptions.status, 'active'),
          ),
        )
        .returning();
      const row = updated[0];
      if (!row) {
        reply.code(404);
        return { error: 'subscription_not_found' };
      }
      return { subscription: serialize(row) };
    },
  );

  // --------------------------------------------------------------------- admin

  fast.get(
    '/api/v1/players/:playerId/subscriptions',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const rows = await app.db
        .select({ subscription: vipSubscriptions, tierName: vipTiers.name })
        .from(vipSubscriptions)
        .innerJoin(vipTiers, eq(vipTiers.id, vipSubscriptions.tierId))
        .where(eq(vipSubscriptions.playerId, req.params.playerId))
        .orderBy(desc(vipSubscriptions.createdAt));
      return { rows: rows.map((r) => serialize(r.subscription, r.tierName)) };
    },
  );

  fast.post(
    '/api/v1/players/:playerId/subscriptions',
    {
      schema: { params: playerIdParams, body: grantBody },
      config: { audit: { action: 'player.subscription.grant', resource: 'player' } },
    },
    async (req, reply) => {
      const denied = grantGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!(await economyEnabled())) {
        reply.code(409);
        return { error: 'economy_disabled' };
      }
      const tier = await resolveTier(req.body.tier_id);
      if (!tier.ok) return replyTierProblem(reply, tier.reason);

      const outcome = await createSubscription({
        playerId: req.params.playerId,
        tierId: req.body.tier_id,
        tier: {
          ...tier,
          days: req.body.renews_every_days ?? tier.days,
          price: req.body.price_bonuses ?? tier.price,
        },
        actorPlayerId: actorId,
        requestId: req.id,
      });
      if (outcome.status === 'already_subscribed') {
        reply.code(409);
        return { error: 'already_subscribed' };
      }
      if (outcome.status !== 'ok') return replyGrantProblem(reply, outcome);
      invalidatePermissionCache(req.params.playerId);

      reply.code(201);
      return {
        balance: outcome.balance,
        role_expires_at: outcome.roleExpiresAt.toISOString(),
        subscription: serialize(outcome.subscription, tier.name),
      };
    },
  );

  /**
   * Charges the first period and enrols the player, in one transaction.
   *
   * The price and period length are copied onto the row (snapshot) so a later
   * catalog edit cannot reprice a live subscription. The partial unique index
   * `vip_subscriptions_one_active_idx` is the single source of truth for "one
   * active subscription per player" — a duplicate surfaces as a unique
   * violation, which is translated to `already_subscribed`.
   */
  async function createSubscription(input: {
    playerId: string;
    tierId: string;
    tier: { roleId: string; days: number; price: number };
    actorPlayerId: string;
    requestId: string;
  }): Promise<
    | { status: 'ok'; balance: number; roleExpiresAt: Date; subscription: VipSubscriptionRow }
    | { status: 'already_subscribed' }
    | Exclude<ApplyVipGrantResult, { status: 'ok' }>
  > {
    const subscriptionId = uuidv7();
    try {
      return await app.db.transaction(async (tx) => {
        const active = await tx
          .select({ id: vipSubscriptions.id })
          .from(vipSubscriptions)
          .where(
            and(
              eq(vipSubscriptions.playerId, input.playerId),
              eq(vipSubscriptions.status, 'active'),
            ),
          )
          .limit(1);
        if (active[0]) return { status: 'already_subscribed' as const };

        const applied = await applyVipGrant(tx, {
          playerId: input.playerId,
          tier: input.tier,
          actorPlayerId: input.actorPlayerId,
          referenceType: 'vip_subscription',
          referenceId: subscriptionId,
        });
        if (applied.status !== 'ok') return applied;

        const inserted = await tx
          .insert(vipSubscriptions)
          .values({
            id: subscriptionId,
            playerId: input.playerId,
            tierId: input.tierId,
            status: 'active',
            renewsEveryDays: input.tier.days,
            priceBonuses: input.tier.price,
            nextRenewalAt: new Date(Date.now() + input.tier.days * DAY_MS),
          })
          .returning();
        const subscription = inserted[0];
        if (!subscription) throw new Error('vip_subscriptions insert returned no row');

        await publishAdminsCfgSyncForAllServers(tx, {
          reason: 'player.role.assign',
          actor_player_id: input.actorPlayerId,
          enqueued_at: new Date().toISOString(),
          request_id: input.requestId,
        });

        return {
          status: 'ok' as const,
          balance: applied.balance,
          roleExpiresAt: applied.roleExpiresAt,
          subscription,
        };
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { status: 'already_subscribed' };
      throw err;
    }
  }
};

/**
 * Backstop for the race the explicit pre-check cannot cover: two concurrent
 * subscribe requests for the same player. `vip_subscriptions_one_active_idx`
 * rejects the loser with 23505 and the whole transaction — including the
 * bonus spend — rolls back. It is the only unique index reachable from this
 * transaction that can collide: the ledger's idempotency key contains a fresh
 * uuidv7 reference id.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (typeof current === 'object' && (current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export default vipSubscriptionRoutes;
