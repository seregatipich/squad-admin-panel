import { COPLAY_DEFAULT_MIN_OVERLAP_SECONDS, COPLAY_DEFAULT_MIN_SHARED_SESSIONS } from '@squad/db';
import { type CoplaySettingsRow, coplaySettings } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const SINGLETON_ID = 1;
/** Cap for both thresholds: 90 days (the co-play rolling window) in seconds, generous for the session-count threshold too. */
const THRESHOLD_MAX = 90 * 24 * 60 * 60;

const putBody = z
  .object({
    min_shared_sessions: z.number().int().min(0).max(THRESHOLD_MAX).optional(),
    min_overlap_seconds: z.number().int().min(0).max(THRESHOLD_MAX).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

interface CoplaySettingsView {
  min_shared_sessions: number;
  min_overlap_seconds: number;
  updated_at: string | null;
  updated_by_player_id: string | null;
}

function serialize(row: CoplaySettingsRow | null): CoplaySettingsView {
  if (!row) {
    return {
      min_shared_sessions: COPLAY_DEFAULT_MIN_SHARED_SESSIONS,
      min_overlap_seconds: COPLAY_DEFAULT_MIN_OVERLAP_SECONDS,
      updated_at: null,
      updated_by_player_id: null,
    };
  }
  return {
    min_shared_sessions: row.minSharedSessions,
    min_overlap_seconds: row.minOverlapSeconds,
    updated_at: row.updatedAt.toISOString(),
    updated_by_player_id: row.updatedByPlayerId,
  };
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
 * ALT-3 co-play noise-floor settings: the `coplay_settings` singleton read by
 * `GET /api/v1/players/:playerId/coplay` and the ALT-1 anti-signal. Reads are
 * gated on `panel_access` only — no IPs are ever involved in the co-play
 * graph. Writes reuse the fine `player:view_ips` permission of
 * `settings-alt-detection`, since tuning these thresholds is part of the same
 * alt/twink toolkit; Owner always short-circuits that check.
 */
const settingsCoplayRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadSettings(): Promise<CoplaySettingsRow | null> {
    const rows = await app.db
      .select()
      .from(coplaySettings)
      .where(eq(coplaySettings.id, SINGLETON_ID))
      .limit(1);
    return rows[0] ?? null;
  }

  fast.get('/api/v1/settings/coplay', { config: { audit: false } }, async (req, reply) => {
    const denied = panelGuard(req, reply);
    if (denied) return denied;
    return serialize(await loadSettings());
  });

  fast.put(
    '/api/v1/settings/coplay',
    {
      schema: { body: putBody },
      config: { permissions: ['player:view_ips'], audit: false },
    },
    async (req) => {
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by the player:view_ips permission gate
      const actorId = req.user!.playerId;
      const before = serialize(await loadSettings());
      const body = req.body;

      const updates: Partial<typeof coplaySettings.$inferInsert> = {
        updatedByPlayerId: actorId,
        updatedAt: new Date(),
      };
      if (body.min_shared_sessions !== undefined)
        updates.minSharedSessions = body.min_shared_sessions;
      if (body.min_overlap_seconds !== undefined)
        updates.minOverlapSeconds = body.min_overlap_seconds;

      await app.db
        .insert(coplaySettings)
        .values({ id: SINGLETON_ID, ...updates })
        .onConflictDoUpdate({ target: coplaySettings.id, set: updates });

      const after = serialize(await loadSettings());
      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'coplay.settings.update',
        targetType: 'coplay_settings',
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

export default settingsCoplayRoutes;
