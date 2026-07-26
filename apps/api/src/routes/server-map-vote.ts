import type { DatabaseClient } from '@squad/db';
import {
  layers,
  MAP_VOTE_SELECTIONS,
  type MapVoteSelection,
  mapVoteCandidates,
  mapVotePicks,
  matches,
  serverSettings,
} from '@squad/db/schema';
import { selectNextLayer } from '@squad/shared-config';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const serverIdParams = z.object({ serverId: z.string().uuid() });

const settingsBody = z.object({
  enabled: z.boolean(),
  selection: z.enum(MAP_VOTE_SELECTIONS),
  layer_cooldown: z.number().int().min(0).max(20),
  map_cooldown: z.number().int().min(0).max(20),
  broadcast_template: z.string().max(300).nullable(),
});

const candidatesBody = z.object({
  candidates: z
    .array(
      z.object({
        layer: z.string().trim().min(1).max(200),
        weight: z.number().int().min(1).max(100),
        enabled: z.boolean(),
      }),
    )
    .max(200),
  confirm_deprecated: z.boolean().optional(),
});

const picksQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

interface MapVoteSettingsView {
  enabled: boolean;
  selection: MapVoteSelection;
  layerCooldown: number;
  mapCooldown: number;
  broadcastTemplate: string | null;
}

const DEFAULT_SETTINGS: MapVoteSettingsView = {
  enabled: false,
  selection: 'weighted_random',
  layerCooldown: 3,
  mapCooldown: 2,
  broadcastTemplate: null,
};

function requireChangemap(
  req: FastifyRequest,
  reply: FastifyReply,
): { error: string; required_squad_permission?: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.squadPermissions.has('changemap')) {
    reply.code(403);
    return { error: 'forbidden', required_squad_permission: 'changemap' };
  }
  return null;
}

async function loadSettings(db: DatabaseClient, serverId: string): Promise<MapVoteSettingsView> {
  const row = await db.query.serverSettings.findFirst({
    where: eq(serverSettings.serverId, serverId),
  });
  if (!row) return DEFAULT_SETTINGS;
  return {
    enabled: row.mapVoteEnabled,
    selection: row.mapVoteSelection,
    layerCooldown: row.mapVoteLayerCooldown,
    mapCooldown: row.mapVoteMapCooldown,
    broadcastTemplate: row.mapVoteBroadcastTemplate,
  };
}

const MAP_VOTE_RECENT_MATCH_LIMIT = 50;

/**
 * GAME-1 (#80): panel-driven map auto-selection per the 2026-07-09
 * map-rotation ADR — a per-server candidate pool + weighted selection rule
 * applied by the scheduler tick via `AdminSetNextLayer` (no in-game chat
 * voting, no `LayerVoting*.cfg`).
 *
 * Reads are gated on `panelAccess`; writes need the `changemap` squad
 * permission and are audited. `GET /preview` runs the exact
 * `selectNextLayer` rule the scheduler tick uses (seeded by the newest match
 * id) so the panel shows the decision the tick would make.
 */
const serverMapVoteRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadCandidateRows(serverId: string) {
    return app.db
      .select({
        id: mapVoteCandidates.id,
        layer: mapVoteCandidates.layer,
        weight: mapVoteCandidates.weight,
        enabled: mapVoteCandidates.enabled,
        map: layers.map,
        gamemode: layers.gamemode,
        deprecated: layers.deprecated,
      })
      .from(mapVoteCandidates)
      .leftJoin(layers, eq(layers.name, mapVoteCandidates.layer))
      .where(eq(mapVoteCandidates.serverId, serverId))
      .orderBy(asc(mapVoteCandidates.layer));
  }

  async function auditMapVoteWrite(
    req: FastifyRequest,
    reply: FastifyReply,
    input: { actionType: string; serverId: string; after: unknown },
  ): Promise<void> {
    if (!req.user) return;
    await writeAuditEntry(app.db, {
      actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
      actorIp: req.ip ?? null,
      actionType: input.actionType,
      targetType: 'server',
      targetId: input.serverId,
      after: input.after,
      context: { requestId: req.id, method: req.method, url: req.url },
      statusCode: reply.statusCode,
    });
  }

  fast.get(
    '/api/v1/servers/:serverId/map-vote',
    { schema: { params: serverIdParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const { serverId } = req.params;
      const [settings, candidates] = await Promise.all([
        loadSettings(app.db, serverId),
        loadCandidateRows(serverId),
      ]);
      return {
        enabled: settings.enabled,
        selection: settings.selection,
        layer_cooldown: settings.layerCooldown,
        map_cooldown: settings.mapCooldown,
        broadcast_template: settings.broadcastTemplate,
        can_edit: req.user.permissions.squadPermissions.has('changemap'),
        candidates: candidates.map((c) => ({
          id: c.id,
          layer: c.layer,
          map: c.map,
          gamemode: c.gamemode,
          weight: c.weight,
          enabled: c.enabled,
          deprecated: c.deprecated ?? false,
        })),
      };
    },
  );

  fast.put(
    '/api/v1/servers/:serverId/map-vote/settings',
    { schema: { params: serverIdParams, body: settingsBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = requireChangemap(req, reply);
      if (denied) return denied;
      const { serverId } = req.params;
      const body = req.body;

      const existing = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, serverId),
      });
      if (!existing) {
        reply.code(404);
        return { error: 'settings_not_found' };
      }

      await app.db
        .update(serverSettings)
        .set({
          mapVoteEnabled: body.enabled,
          mapVoteSelection: body.selection,
          mapVoteLayerCooldown: body.layer_cooldown,
          mapVoteMapCooldown: body.map_cooldown,
          mapVoteBroadcastTemplate: body.broadcast_template,
        })
        .where(eq(serverSettings.serverId, serverId));

      await auditMapVoteWrite(req, reply, {
        actionType: 'server.map_vote.settings.write',
        serverId,
        after: body,
      });
      return { ok: true };
    },
  );

  fast.put(
    '/api/v1/servers/:serverId/map-vote/candidates',
    { schema: { params: serverIdParams, body: candidatesBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = requireChangemap(req, reply);
      if (denied) return denied;
      // biome-ignore lint/style/noNonNullAssertion: requireChangemap already 401s when req.user is missing
      const user = req.user!;
      const { serverId } = req.params;
      const { candidates, confirm_deprecated } = req.body;

      const names = candidates.map((c) => c.layer);
      if (new Set(names).size !== names.length) {
        reply.code(400);
        return { error: 'duplicate_layer' };
      }

      const catalogRows = names.length
        ? await app.db.select().from(layers).where(inArray(layers.name, names))
        : [];
      const catalog = new Map(catalogRows.map((row) => [row.name, row]));
      for (const name of names) {
        const row = catalog.get(name);
        if (!row) {
          reply.code(404);
          return { error: 'unknown_layer', layer: name };
        }
        if (row.deprecated && !confirm_deprecated) {
          reply.code(409);
          return { error: 'deprecated_layer_confirmation_required', layer: name };
        }
      }

      await app.db.transaction(async (tx) => {
        await tx.delete(mapVoteCandidates).where(eq(mapVoteCandidates.serverId, serverId));
        if (candidates.length > 0) {
          await tx.insert(mapVoteCandidates).values(
            candidates.map((c) => ({
              serverId,
              layer: c.layer,
              weight: c.weight,
              enabled: c.enabled,
              createdBy: user.playerId,
            })),
          );
        }
      });

      await auditMapVoteWrite(req, reply, {
        actionType: 'server.map_vote.candidates.write',
        serverId,
        after: { count: candidates.length, candidates },
      });
      return { ok: true, count: candidates.length };
    },
  );

  fast.get(
    '/api/v1/servers/:serverId/map-vote/preview',
    { schema: { params: serverIdParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const { serverId } = req.params;

      const [settings, candidateRows, recentRows, latestMatch] = await Promise.all([
        loadSettings(app.db, serverId),
        loadCandidateRows(serverId),
        app.db
          .select({ layer: matches.layer, map: matches.map, isSeed: matches.isSeed })
          .from(matches)
          .where(eq(matches.serverId, serverId))
          .orderBy(desc(matches.startedAt))
          .limit(MAP_VOTE_RECENT_MATCH_LIMIT),
        app.db.query.matches.findFirst({
          where: eq(matches.serverId, serverId),
          orderBy: desc(matches.startedAt),
        }),
      ]);

      const result = selectNextLayer({
        // Candidates whose layer left the catalog cannot be applied — drop them.
        candidates: candidateRows
          .filter((c) => c.map !== null)
          .map((c) => ({
            layer: c.layer,
            map: c.map as string,
            weight: c.weight,
            enabled: c.enabled,
            deprecated: c.deprecated ?? false,
          })),
        recentMatches: recentRows
          .filter((row) => row.layer !== null)
          .map((row) => ({ layer: row.layer as string, map: row.map ?? '', isSeed: row.isSeed })),
        settings: {
          selection: settings.selection,
          layerCooldown: settings.layerCooldown,
          mapCooldown: settings.mapCooldown,
        },
        // Same seed the scheduler tick uses for this match, so the preview
        // shows the exact pick the tick would apply.
        seed: latestMatch?.id ?? serverId,
      });

      return { eligible: result.eligible, excluded: result.excluded, would_pick: result.pick };
    },
  );

  fast.get(
    '/api/v1/servers/:serverId/map-vote/picks',
    { schema: { params: serverIdParams, querystring: picksQuery }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const { serverId } = req.params;
      const rows = await app.db
        .select()
        .from(mapVotePicks)
        .where(eq(mapVotePicks.serverId, serverId))
        .orderBy(desc(mapVotePicks.createdAt))
        .limit(req.query.limit);
      return {
        picks: rows.map((row) => ({
          id: row.id,
          match_id: row.matchId,
          layer: row.layer,
          selection: row.selection,
          applied: row.applied,
          failure_reason: row.failureReason,
          created_at: row.createdAt.toISOString(),
        })),
      };
    },
  );
};

export default serverMapVoteRoutes;
