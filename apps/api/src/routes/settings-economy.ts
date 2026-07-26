import {
  type EconomySettingsRow,
  economySettings,
  type PrivilegeCostCatalog,
  roles,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const SINGLETON_ID = 1;
const COEFFICIENT_MAX = 1000;
const SEED_THRESHOLD_MAX = 100;
const SEED_REWARD_THRESHOLD_HOURS_MAX = 720;
const PRIVILEGE_DAYS_MAX = 3650;
const PRIVILEGE_PRICE_MAX = 100_000_000;
const VIP_EXPIRY_WINDOW_DAYS_MIN = 1;
const VIP_EXPIRY_WINDOW_DAYS_MAX = 90;
const VIP_EXPIRY_WINDOWS_MAX_COUNT = 10;

const DEFAULT_SETTINGS = {
  k_online: 1,
  k_boost: 2,
  k_seed: 3,
  seed_threshold: 40,
  economy_enabled: false,
  privilege_costs: {} as PrivilegeCostCatalog,
  seed_reward_threshold_hours_per_month: 0,
  seed_reward_role_id: null as string | null,
  vip_expiry_windows_days: [7, 3, 1] as number[],
  vip_expiry_warn_in_game: true,
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
    seed_reward_threshold_hours_per_month: z
      .number()
      .finite()
      .min(0)
      .max(SEED_REWARD_THRESHOLD_HOURS_MAX)
      .optional(),
    seed_reward_role_id: z.string().uuid().nullable().optional(),
    vip_expiry_windows_days: z
      .array(z.number().int().min(VIP_EXPIRY_WINDOW_DAYS_MIN).max(VIP_EXPIRY_WINDOW_DAYS_MAX))
      .min(1)
      .max(VIP_EXPIRY_WINDOWS_MAX_COUNT)
      .optional(),
    vip_expiry_warn_in_game: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

interface EconomySettingsView {
  k_online: number;
  k_boost: number;
  k_seed: number;
  seed_threshold: number;
  economy_enabled: boolean;
  privilege_costs: PrivilegeCostCatalog;
  seed_reward_threshold_hours_per_month: number;
  seed_reward_role_id: string | null;
  vip_expiry_windows_days: number[];
  vip_expiry_warn_in_game: boolean;
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

function updateGuard(
  req: FastifyRequest,
  reply: FastifyReply,
  body: z.infer<typeof putBody>,
): { error: string; required?: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  const changesSeedReward =
    body.seed_reward_threshold_hours_per_month !== undefined ||
    body.seed_reward_role_id !== undefined;
  const changesEconomy =
    body.k_online !== undefined ||
    body.k_boost !== undefined ||
    body.k_seed !== undefined ||
    body.seed_threshold !== undefined ||
    body.economy_enabled !== undefined ||
    body.privilege_costs !== undefined ||
    body.vip_expiry_windows_days !== undefined ||
    body.vip_expiry_warn_in_game !== undefined;
  if (changesEconomy && !req.user.permissions.canManageEconomy) {
    reply.code(403);
    return { error: 'forbidden', required: 'can_manage_economy' };
  }
  if (changesSeedReward && !req.user.permissions.canEditRoles) {
    reply.code(403);
    return { error: 'forbidden', required: 'can_edit_roles' };
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
    seed_reward_threshold_hours_per_month: row.seedRewardThresholdHoursPerMonth,
    seed_reward_role_id: row.seedRewardRoleId,
    vip_expiry_windows_days: row.vipExpiryWindowsDays,
    vip_expiry_warn_in_game: row.vipExpiryWarnInGame,
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
      const denied = updateGuard(req, reply, req.body);
      if (denied) return denied;
      const actorId = req.user?.playerId;
      if (!actorId) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }

      const before = serialize(await loadSettings());
      const body = req.body;
      const rewardRoleId =
        body.seed_reward_role_id === undefined
          ? before.seed_reward_role_id
          : body.seed_reward_role_id;
      if (rewardRoleId) {
        const [rewardRole] = await app.db
          .select({ id: roles.id, panelAccess: roles.panelAccess })
          .from(roles)
          .where(eq(roles.id, rewardRoleId))
          .limit(1);
        if (!rewardRole) {
          reply.code(422);
          return { error: 'seed_reward_role_not_found' };
        }
        if (rewardRole.panelAccess) {
          reply.code(422);
          return { error: 'seed_reward_role_requires_no_panel_access' };
        }
      }
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
      if (body.seed_reward_threshold_hours_per_month !== undefined) {
        updates.seedRewardThresholdHoursPerMonth = body.seed_reward_threshold_hours_per_month;
      }
      if (body.seed_reward_role_id !== undefined) {
        updates.seedRewardRoleId = body.seed_reward_role_id;
      }
      if (body.vip_expiry_windows_days !== undefined) {
        updates.vipExpiryWindowsDays = body.vip_expiry_windows_days;
      }
      if (body.vip_expiry_warn_in_game !== undefined) {
        updates.vipExpiryWarnInGame = body.vip_expiry_warn_in_game;
      }

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
