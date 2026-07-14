import {
  BANLIST_PUBLICATION_DEFAULT_SCOPE,
  type BanlistPublicationSettingsRow,
  banlistPublicationSettings,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const SINGLETON_ID = 1;

const DEFAULT_SETTINGS = {
  enabled: false,
  publish_scope: BANLIST_PUBLICATION_DEFAULT_SCOPE,
} as const;

const putBody = z.object({
  enabled: z.boolean(),
  publish_scope: z.enum(['all_active', 'permanent_only']),
});

interface BanlistPublicationSettingsView {
  enabled: boolean;
  publish_scope: string;
  updated_at: string | null;
  updated_by_player_id: string | null;
}

function manageGuard(
  req: FastifyRequest,
  reply: FastifyReply,
): { error: string; required?: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.canManageBanSources) {
    reply.code(403);
    return { error: 'forbidden', required: 'can_manage_ban_sources' };
  }
  return null;
}

function serialize(row: BanlistPublicationSettingsRow | null): BanlistPublicationSettingsView {
  if (!row) {
    return { ...DEFAULT_SETTINGS, updated_at: null, updated_by_player_id: null };
  }
  return {
    enabled: row.enabled,
    publish_scope: row.publishScope,
    updated_at: row.updatedAt.toISOString(),
    updated_by_player_id: row.updatedByPlayerId,
  };
}

/**
 * Master switch + scope for outbound banlist federation (CBAN-5): controls
 * whether `GET /api/v1/public/banlist` serves anything at all, and whether it
 * includes temporary bans (`all_active`) or only permanent ones
 * (`permanent_only`). Both read and write require `can_manage_ban_sources`,
 * since knowing whether federation is enabled is itself sensitive. Mirrors
 * `settings-clan-guard.ts`'s singleton-row pattern.
 */
const settingsBanlistPublicationRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadSettings(): Promise<BanlistPublicationSettingsRow | null> {
    const rows = await app.db
      .select()
      .from(banlistPublicationSettings)
      .where(eq(banlistPublicationSettings.id, SINGLETON_ID))
      .limit(1);
    return rows[0] ?? null;
  }

  fast.get(
    '/api/v1/settings/banlist-publication',
    { config: { audit: false } },
    async (req, reply) => {
      const denied = manageGuard(req, reply);
      if (denied) return denied;
      return serialize(await loadSettings());
    },
  );

  fast.put(
    '/api/v1/settings/banlist-publication',
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
      const updates = {
        enabled: req.body.enabled,
        publishScope: req.body.publish_scope,
        updatedByPlayerId: actorId,
        updatedAt: new Date(),
      };

      await app.db
        .insert(banlistPublicationSettings)
        .values({ id: SINGLETON_ID, ...updates })
        .onConflictDoUpdate({ target: banlistPublicationSettings.id, set: updates });

      const after = serialize(await loadSettings());

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actorId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'settings.banlist_publication.update',
        targetType: 'banlist_publication_settings',
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

export default settingsBanlistPublicationRoutes;
