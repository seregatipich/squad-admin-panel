import {
  BONUS_TX_TYPES,
  type BonusTransactionRow,
  bonusTransactions,
  players,
} from '@squad/db/schema';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

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
const historyQuery = z.object({
  type: z.enum(BONUS_TX_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  before: z.coerce.number().int().positive().optional(),
});
const countQuery = z.object({ type: z.enum(BONUS_TX_TYPES).optional() });

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
      config: { permissions: ['role:edit'], audit: false },
    },
    async (req, reply) => {
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
};

export default economyRoutes;
