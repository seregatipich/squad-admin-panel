import {
  BONUS_TX_TYPES,
  type BonusTransactionRow,
  bonusTransactions,
  economySettings,
  players,
  roles,
  vipTiers,
} from '@squad/db/schema';
import { and, asc, desc, eq, gte, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { publishAdminsCfgSyncForAllServers } from '../lib/admins-cfg-sync.js';
import { writeAuditEntry } from '../lib/audit.js';
import { invalidatePermissionCache } from '../lib/rbac.js';

const COMMENT_MAX = 512;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const INT32_MAX = 2_147_483_647;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const adjustBody = z.object({
  amount: z
    .number()
    .int()
    .gte(-INT32_MAX)
    .lte(INT32_MAX)
    .refine((n) => n !== 0, { message: 'amount must be non-zero' }),
  comment: z.string().trim().min(1).max(COMMENT_MAX),
});
const purchaseBody = z.object({ tier_id: z.string().uuid() });
const historyQuery = z.object({
  type: z.enum(BONUS_TX_TYPES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  before: z.coerce.number().int().positive().optional(),
});
const countQuery = z.object({
  type: z.enum(BONUS_TX_TYPES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

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

function manageGuard(
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
  return null;
}

/**
 * Guard for the privilege-shop purchase (ECON-6): the purchase both spends the
 * ledger AND grants an RBAC role, so it requires `can_manage_economy` and
 * `can_assign_roles` together — otherwise economy managers could self-grant
 * roles they cannot assign through the role route.
 */
function purchaseGuard(
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

function serializeTransaction(row: BonusTransactionRow) {
  return {
    id: Number(row.id),
    player_id: row.playerId,
    amount: row.amount,
    type: row.type,
    reference_type: row.referenceType,
    reference_id: row.referenceId,
    comment: row.comment,
    actor_player_id: row.actorPlayerId,
    created_at: row.createdAt.toISOString(),
  };
}

const economyRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/bonus-balance',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const { playerId } = req.params;
      const rows = await app.db
        .select({ balance: players.bonusBalance })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      const player = rows[0];
      if (!player) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      return { player_id: playerId, balance: player.balance };
    },
  );

  fast.get(
    '/api/v1/players/:playerId/bonus-transactions',
    { schema: { params: playerIdParams, querystring: historyQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const { playerId } = req.params;
      const limit = req.query.limit ?? DEFAULT_LIMIT;
      const conditions = [eq(bonusTransactions.playerId, playerId)];
      if (req.query.type) conditions.push(eq(bonusTransactions.type, req.query.type));
      if (req.query.from) conditions.push(gte(bonusTransactions.createdAt, req.query.from));
      if (req.query.to) conditions.push(lte(bonusTransactions.createdAt, req.query.to));
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
        items: page.map(serializeTransaction),
        next_cursor: hasMore && last ? Number(last.id) : null,
      };
    },
  );

  fast.get(
    '/api/v1/players/:playerId/bonus-transactions/count',
    { schema: { params: playerIdParams, querystring: countQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      const { playerId } = req.params;
      const conditions = [eq(bonusTransactions.playerId, playerId)];
      if (req.query.type) conditions.push(eq(bonusTransactions.type, req.query.type));
      if (req.query.from) conditions.push(gte(bonusTransactions.createdAt, req.query.from));
      if (req.query.to) conditions.push(lte(bonusTransactions.createdAt, req.query.to));
      const rows = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(bonusTransactions)
        .where(and(...conditions));
      return { count: rows[0]?.count ?? 0 };
    },
  );

  fast.post(
    '/api/v1/players/:playerId/bonus-adjustments',
    {
      schema: { params: playerIdParams, body: adjustBody },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = manageGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const { playerId } = req.params;
      const { amount, comment } = req.body;

      const outcome = await app.db.transaction(async (tx) => {
        const locked = await tx
          .select({ balance: players.bonusBalance })
          .from(players)
          .where(eq(players.id, playerId))
          .for('update')
          .limit(1);
        const current = locked[0];
        if (!current) return { status: 'not_found' as const };

        const nextBalance = current.balance + amount;
        if (nextBalance < 0) {
          return { status: 'insufficient' as const, balance: current.balance };
        }

        const inserted = await tx
          .insert(bonusTransactions)
          .values({ playerId, amount, type: 'adjust', comment, actorPlayerId: actorId })
          .returning();
        const ledgerRow = inserted[0];
        if (!ledgerRow) throw new Error('bonus_transactions insert returned no row');

        await tx
          .update(players)
          .set({ bonusBalance: nextBalance, updatedAt: new Date() })
          .where(eq(players.id, playerId));

        return {
          status: 'ok' as const,
          before: current.balance,
          after: nextBalance,
          ledgerRow,
        };
      });

      if (outcome.status === 'not_found') {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      if (outcome.status === 'insufficient') {
        reply.code(409);
        return { error: 'insufficient_balance', balance: outcome.balance };
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'player.bonus.adjust',
        targetType: 'player',
        targetId: playerId,
        before: { bonus_balance: outcome.before },
        after: { bonus_balance: outcome.after },
        context: { player_id: playerId, amount, request_id: req.id },
        statusCode: 201,
      });

      reply.code(201);
      return {
        player_id: playerId,
        balance: outcome.after,
        transaction: serializeTransaction(outcome.ledgerRow),
      };
    },
  );

  fast.get('/api/v1/bonus-shop/tiers', { config: { audit: false } }, async (req, reply) => {
    const denied = panelGuard(req, reply);
    if (denied) return denied;
    const rows = await app.db
      .select()
      .from(vipTiers)
      .where(and(eq(vipTiers.isActive, true), isNotNull(vipTiers.priceBonuses)))
      .orderBy(asc(vipTiers.sortOrder), asc(vipTiers.name));
    return {
      tiers: rows.map((row) => ({
        id: row.id,
        name: row.name,
        role_id: row.roleId,
        description: row.description,
        default_days: row.defaultDays,
        sort_order: row.sortOrder,
        is_active: row.isActive,
        price_bonuses: row.priceBonuses,
      })),
    };
  });

  fast.post(
    '/api/v1/players/:playerId/bonus-purchases',
    {
      schema: { params: playerIdParams, body: purchaseBody },
      config: { audit: { action: 'player.bonus.purchase', resource: 'player' } },
    },
    async (req, reply) => {
      const denied = purchaseGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      const { playerId } = req.params;
      const tierId = req.body.tier_id;

      const [economyRow] = await app.db
        .select({ enabled: economySettings.economyEnabled })
        .from(economySettings)
        .limit(1);
      if (!(economyRow?.enabled ?? false)) {
        reply.code(409);
        return { error: 'economy_disabled' };
      }

      const [tier] = await app.db
        .select({
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
      if (!tier) {
        reply.code(404);
        return { error: 'tier_not_found' };
      }
      // default_days is guaranteed by vip_tiers_price_requires_days_chk when a
      // price is set; the second condition is a defensive narrowing for TS.
      if (tier.priceBonuses == null || tier.defaultDays == null) {
        reply.code(409);
        return { error: 'tier_not_purchasable' };
      }
      // Rule 7 escalation guard: an economy manager must not be able to convert
      // minted bonuses into a role that opens the panel or a system role.
      if (tier.rolePanelAccess || tier.roleIsSystem) {
        reply.code(403);
        return { error: 'role_grants_panel_access' };
      }

      const price = tier.priceBonuses;
      const grantDays = tier.defaultDays;

      const outcome = await app.db.transaction(async (tx) => {
        const locked = await tx
          .select({
            balance: players.bonusBalance,
            roleId: players.roleId,
            roleExpiresAt: players.roleExpiresAt,
          })
          .from(players)
          .where(eq(players.id, playerId))
          .for('update')
          .limit(1);
        const current = locked[0];
        if (!current) return { status: 'not_found' as const };

        const nextBalance = current.balance - price;
        if (nextBalance < 0) {
          return { status: 'insufficient' as const, balance: current.balance };
        }
        const sameRole = current.roleId === tier.roleId;
        if (current.roleId !== null && !sameRole) {
          return { status: 'role_conflict' as const };
        }
        if (sameRole && current.roleExpiresAt === null) {
          return { status: 'role_permanent' as const };
        }

        const now = new Date();
        const base =
          sameRole && current.roleExpiresAt !== null && current.roleExpiresAt > now
            ? current.roleExpiresAt
            : now;
        const roleExpiresAt = new Date(base.getTime() + grantDays * 86_400_000);

        const inserted = await tx
          .insert(bonusTransactions)
          .values({
            playerId,
            amount: -price,
            type: 'spend',
            referenceType: 'purchase',
            referenceId: tierId,
            actorPlayerId: actorId,
          })
          .returning();
        const ledgerRow = inserted[0];
        if (!ledgerRow) throw new Error('bonus_transactions insert returned no row');

        await tx
          .update(players)
          .set({
            bonusBalance: nextBalance,
            roleId: tier.roleId,
            roleExpiresAt,
            updatedAt: now,
          })
          .where(eq(players.id, playerId));

        await publishAdminsCfgSyncForAllServers(tx, app.redis, {
          reason: 'player.role.assign',
          actor_player_id: actorId,
          enqueued_at: new Date().toISOString(),
          request_id: req.id,
        });

        return { status: 'ok' as const, balance: nextBalance, roleExpiresAt };
      });

      if (outcome.status === 'not_found') {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      if (outcome.status === 'insufficient') {
        reply.code(409);
        return { error: 'insufficient_balance', balance: outcome.balance };
      }
      if (outcome.status === 'role_conflict') {
        reply.code(409);
        return { error: 'role_conflict' };
      }
      if (outcome.status === 'role_permanent') {
        reply.code(409);
        return { error: 'role_permanent' };
      }

      invalidatePermissionCache(playerId);

      reply.code(201);
      return {
        ok: true,
        balance: outcome.balance,
        role_id: tier.roleId,
        role_expires_at: outcome.roleExpiresAt.toISOString(),
      };
    },
  );
};

export default economyRoutes;
