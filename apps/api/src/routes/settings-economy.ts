import {
  type EconomySettingsRow,
  economySettings,
  type PrivilegeCostCatalog,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const SINGLETON_ID = 1;
const COEFFICIENT_MAX = 1000;
const SEED_THRESHOLD_MAX = 100;
const PRIVILEGE_DAYS_MAX = 3650;
const PRIVILEGE_PRICE_MAX = 100_000_000;

const DEFAULT_SETTINGS = {
  k_online: 1,
  k_boost: 2,
  k_seed: 3,
  seed_threshold: 40,
  economy_enabled: false,
  privilege_costs: {} as PrivilegeCostCatalog,
} as const;

const coefficient = z.number().finite().min(0).max(COEFFICIENT_MAX);
const privilegeCost = z.object({
  days: z.number().int().min(1).max(PRIVILEGE_DAYS_MAX),
  price: z.number().int().min(0).max(PRIVILEGE_PRICE_MAX),
});
const privilegeCosts = z.record(z.string().min(1).max(64), privilegeCost);

const putBody = z
  .object({
    k_online: coefficient.optional(),
    k_boost: coefficient.optional(),
    k_seed: coefficient.optional(),
    seed_threshold: z.number().int().min(0).max(SEED_THRESHOLD_MAX).optional(),
    economy_enabled: z.boolean().optional(),
    privilege_costs: privilegeCosts.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

interface EconomySettingsView {
  k_online: number;
  k_boost: number;
  k_seed: number;
  seed_threshold: number;
  economy_enabled: boolean;
  privilege_costs: PrivilegeCostCatalog;
  updated_at: string | null;
  updated_by_player_id: string | null;
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

function serialize(row: EconomySettingsRow | null): EconomySettingsView {
  if (!row) {
    return { ...DEFAULT_SETTINGS, updated_at: null, updated_by_player_id: null };
  }
  return {
    k_online: row.kOnline,
    k_boost: row.kBoost,
    k_seed: row.kSeed,
    seed_threshold: row.seedThreshold,
    economy_enabled: row.economyEnabled,
    privilege_costs: row.privilegeCosts,
    updated_at: row.updatedAt.toISOString(),
    updated_by_player_id: row.updatedByPlayerId,
  };
}

const settingsEconomyRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadSettings(): Promise<EconomySettingsRow | null> {
    const rows = await app.db
      .select()
      .from(economySettings)
      .where(eq(economySettings.id, SINGLETON_ID))
      .limit(1);
    return rows[0] ?? null;
  }

  fast.get('/api/v1/settings/economy', { config: { audit: false } }, async (req, reply) => {
    const denied = panelGuard(req, reply);
    if (denied) return denied;
    return serialize(await loadSettings());
  });

  fast.put(
    '/api/v1/settings/economy',
    { schema: { body: putBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = manageGuard(req, reply);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const before = serialize(await loadSettings());
      const body = req.body;
      const updates: Partial<typeof economySettings.$inferInsert> = {
        updatedByPlayerId: actorId,
        updatedAt: new Date(),
      };
      if (body.k_online !== undefined) updates.kOnline = body.k_online;
      if (body.k_boost !== undefined) updates.kBoost = body.k_boost;
      if (body.k_seed !== undefined) updates.kSeed = body.k_seed;
      if (body.seed_threshold !== undefined) updates.seedThreshold = body.seed_threshold;
      if (body.economy_enabled !== undefined) updates.economyEnabled = body.economy_enabled;
      if (body.privilege_costs !== undefined) updates.privilegeCosts = body.privilege_costs;

      await app.db
        .insert(economySettings)
        .values({ id: SINGLETON_ID, ...updates })
        .onConflictDoUpdate({ target: economySettings.id, set: updates });

      const after = serialize(await loadSettings());

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'economy.settings.update',
        targetType: 'economy_settings',
        targetId: String(SINGLETON_ID),
        before,
        after,
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: 200,
      });

      return after;
    },
  );
};

export default settingsEconomyRoutes;
