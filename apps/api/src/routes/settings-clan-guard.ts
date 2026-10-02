import {
  CLAN_GUARD_DEFAULT_GRACE_PERIOD_SECONDS,
  type ClanGuardSettingsRow,
  clanGuardSettings,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requestUser } from '../lib/request-user.js';

const SINGLETON_ID = 1;
const GRACE_PERIOD_MAX_SECONDS = 3600;

const DEFAULT_SETTINGS = {
  enabled: true,
  grace_period_seconds: CLAN_GUARD_DEFAULT_GRACE_PERIOD_SECONDS,
} as const;

const patchBody = z
  .object({
    enabled: z.boolean().optional(),
    grace_period_seconds: z.number().int().min(0).max(GRACE_PERIOD_MAX_SECONDS).optional(),
  })
  .refine((value) => value.enabled !== undefined || value.grace_period_seconds !== undefined, {
    message: 'empty_update',
  });

interface ClanGuardSettingsView {
  enabled: boolean;
  grace_period_seconds: number;
  updated_at: string | null;
  updated_by_player_id: string | null;
}

function serialize(row: ClanGuardSettingsRow | null): ClanGuardSettingsView {
  if (!row) {
    return { ...DEFAULT_SETTINGS, updated_at: null, updated_by_player_id: null };
  }
  return {
    enabled: row.enabled,
    grace_period_seconds: row.gracePeriodSeconds,
    updated_at: row.updatedAt.toISOString(),
    updated_by_player_id: row.updatedByPlayerId,
  };
}

/**
 * Global kill-switch + grace-period settings for the clan-tag-protection
 * guard (CLAN-5). Read is available to any panel user (`roleFlags:
 * ['panelAccess']`); writes require `canManageClans`. Both are declared on the
 * route and enforced by the global hook in `plugins/auth.ts`. The clan-guard worker reads this singleton row
 * every tick and skips entirely when `enabled` is false.
 */
const settingsClanGuardRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadSettings(): Promise<ClanGuardSettingsRow | null> {
    const rows = await app.db
      .select()
      .from(clanGuardSettings)
      .where(eq(clanGuardSettings.id, SINGLETON_ID))
      .limit(1);
    return rows[0] ?? null;
  }

  fast.get(
    '/api/v1/settings/clan-guard',
    { config: { audit: false, roleFlags: ['panelAccess'] } },
    async () => serialize(await loadSettings()),
  );

  fast.patch(
    '/api/v1/settings/clan-guard',
    {
      schema: { body: patchBody },
      config: {
        audit: { action: 'clan_guard.settings.update', resource: 'clan_guard_settings' },
        roleFlags: ['canManageClans'],
      },
    },
    async (req) => {
      const actorId = requestUser(req).playerId;

      const before = serialize(await loadSettings());
      const body = req.body;
      const updates: Partial<typeof clanGuardSettings.$inferInsert> = {
        updatedByPlayerId: actorId,
        updatedAt: new Date(),
      };
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.grace_period_seconds !== undefined)
        updates.gracePeriodSeconds = body.grace_period_seconds;

      await app.db
        .insert(clanGuardSettings)
        .values({ id: SINGLETON_ID, ...updates })
        .onConflictDoUpdate({ target: clanGuardSettings.id, set: updates });

      const after = serialize(await loadSettings());

      req.auditSnapshots = { targetId: String(SINGLETON_ID), before, after };

      return after;
    },
  );
};

export default settingsClanGuardRoutes;
