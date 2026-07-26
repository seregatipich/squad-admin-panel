import { players, roles, type VipTierRow, vipTiers } from '@squad/db/schema';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const DEFAULT_DAYS_MAX = 3650;
const SORT_ORDER_MAX = 100_000;
const PRICE_BONUSES_MAX = 2_147_483_647;

const idParam = z.object({ id: z.string().uuid() });

const createBody = z.object({
  name: z.string().trim().min(1).max(64),
  role_id: z.string().uuid(),
  description: z.string().trim().max(1024).nullish(),
  default_days: z.number().int().min(1).max(DEFAULT_DAYS_MAX).nullish(),
  price_bonuses: z.number().int().min(0).max(PRICE_BONUSES_MAX).nullish(),
  sort_order: z.number().int().min(0).max(SORT_ORDER_MAX).default(0),
  is_active: z.boolean().default(true),
});

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    role_id: z.string().uuid().optional(),
    description: z.string().trim().max(1024).nullable().optional(),
    default_days: z.number().int().min(1).max(DEFAULT_DAYS_MAX).nullable().optional(),
    price_bonuses: z.number().int().min(0).max(PRICE_BONUSES_MAX).nullable().optional(),
    sort_order: z.number().int().min(0).max(SORT_ORDER_MAX).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

interface VipTierView {
  id: string;
  name: string;
  role_id: string;
  description: string | null;
  default_days: number | null;
  price_bonuses: number | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function serialize(row: VipTierRow): VipTierView {
  return {
    id: row.id,
    name: row.name,
    role_id: row.roleId,
    description: row.description,
    default_days: row.defaultDays,
    price_bonuses: row.priceBonuses,
    sort_order: row.sortOrder,
    is_active: row.isActive,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Guard for VIP-tier management. The catalog is administered from the
 * `/settings/economy` "VIP tiers" section behind the `can_edit_roles` gate,
 * because a tier composes RBAC roles (VIPSUB-3, issue #169).
 */
function editRolesGuard(
  req: FastifyRequest,
  reply: FastifyReply,
): { error: string; required?: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.canEditRoles) {
    reply.code(403);
    return { error: 'forbidden', required: 'can_edit_roles' };
  }
  return null;
}

const vipTiersRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadRow(id: string): Promise<VipTierRow | null> {
    const rows = await app.db.select().from(vipTiers).where(eq(vipTiers.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async function roleExists(roleId: string): Promise<boolean> {
    const rows = await app.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, roleId))
      .limit(1);
    return rows.length > 0;
  }

  fast.get('/api/v1/vip-tiers', { config: { audit: false } }, async (req, reply) => {
    const denied = editRolesGuard(req, reply);
    if (denied) return denied;
    const rows = await app.db
      .select()
      .from(vipTiers)
      .orderBy(asc(vipTiers.sortOrder), asc(vipTiers.name));
    return { rows: rows.map(serialize) };
  });

  fast.post(
    '/api/v1/vip-tiers',
    { schema: { body: createBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = editRolesGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const body = req.body;
      if (!(await roleExists(body.role_id))) {
        reply.code(400);
        return { error: 'role_not_found' };
      }
      if (body.price_bonuses != null && body.default_days == null) {
        reply.code(422);
        return { error: 'price_requires_days' };
      }

      const id = uuidv7();
      try {
        await app.db.insert(vipTiers).values({
          id,
          name: body.name,
          roleId: body.role_id,
          description: body.description ?? null,
          defaultDays: body.default_days ?? null,
          priceBonuses: body.price_bonuses ?? null,
          sortOrder: body.sort_order,
          isActive: body.is_active,
        });
      } catch (err) {
        if (
          (err as { code?: string }).code === '23505' ||
          (err as { cause?: { code?: string } }).cause?.code === '23505'
        ) {
          reply.code(409);
          return { error: 'vip_tier_name_taken' };
        }
        throw err;
      }

      const after = await loadRow(id);
      if (!after) {
        reply.code(500);
        return { error: 'persist_failed' };
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'vip_tier.create',
        targetType: 'vip_tier',
        targetId: id,
        before: null,
        after: serialize(after),
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 201,
      });

      reply.code(201);
      return serialize(after);
    },
  );

  fast.put(
    '/api/v1/vip-tiers/:id',
    { schema: { params: idParam, body: updateBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = editRolesGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const before = await loadRow(req.params.id);
      if (!before) {
        reply.code(404);
        return { error: 'vip_tier_not_found' };
      }

      const body = req.body;
      if (body.role_id !== undefined && !(await roleExists(body.role_id))) {
        reply.code(400);
        return { error: 'role_not_found' };
      }

      const nextPrice = body.price_bonuses !== undefined ? body.price_bonuses : before.priceBonuses;
      const nextDays = body.default_days !== undefined ? body.default_days : before.defaultDays;
      if (nextPrice != null && nextDays == null) {
        reply.code(422);
        return { error: 'price_requires_days' };
      }

      const updates: Partial<typeof vipTiers.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.role_id !== undefined) updates.roleId = body.role_id;
      if (body.description !== undefined) updates.description = body.description;
      if (body.default_days !== undefined) updates.defaultDays = body.default_days;
      if (body.price_bonuses !== undefined) updates.priceBonuses = body.price_bonuses;
      if (body.sort_order !== undefined) updates.sortOrder = body.sort_order;
      if (body.is_active !== undefined) updates.isActive = body.is_active;

      try {
        await app.db.update(vipTiers).set(updates).where(eq(vipTiers.id, req.params.id));
      } catch (err) {
        if (
          (err as { code?: string }).code === '23505' ||
          (err as { cause?: { code?: string } }).cause?.code === '23505'
        ) {
          reply.code(409);
          return { error: 'vip_tier_name_taken' };
        }
        throw err;
      }

      const after = await loadRow(req.params.id);
      if (!after) {
        reply.code(500);
        return { error: 'persist_failed' };
      }

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'vip_tier.update',
        targetType: 'vip_tier',
        targetId: req.params.id,
        before: serialize(before),
        after: serialize(after),
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 200,
      });

      return serialize(after);
    },
  );

  fast.delete(
    '/api/v1/vip-tiers/:id',
    { schema: { params: idParam }, config: { audit: false } },
    async (req, reply) => {
      const denied = editRolesGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const before = await loadRow(req.params.id);
      if (!before) {
        reply.code(404);
        return { error: 'vip_tier_not_found' };
      }

      // A tier grants its role via VIPSUB-1 (players.role_id + role_expires_at).
      // Refuse deletion while players still hold that role on a live grant, so
      // the catalog stays consistent with outstanding subscriptions.
      const activeCount = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(players)
        .where(
          and(
            eq(players.roleId, before.roleId),
            or(isNull(players.roleExpiresAt), gt(players.roleExpiresAt, new Date())),
          ),
        );
      if ((activeCount[0]?.count ?? 0) > 0) {
        reply.code(409);
        return { error: 'vip_tier_has_active_assignments' };
      }

      await app.db.delete(vipTiers).where(eq(vipTiers.id, req.params.id));

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'vip_tier.delete',
        targetType: 'vip_tier',
        targetId: req.params.id,
        before: serialize(before),
        after: null,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 200,
      });

      return { ok: true };
    },
  );
};

export default vipTiersRoutes;
