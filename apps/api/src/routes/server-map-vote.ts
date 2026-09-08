import type { DatabaseClient } from '@squad/db';
import {
  configVersions,
  layers,
  MAP_VOTE_SELECTIONS,
  type MapVoteSelection,
  mapVoteCandidates,
  mapVotePicks,
  matches,
  players,
  serverSettings,
} from '@squad/db/schema';
import { selectNextLayer } from '@squad/shared-config';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import {
  MAP_VOTE_VERSION_FILENAME,
  type MapVoteSnapshot,
  parseMapVoteSnapshot,
  recordMapVoteVersion,
} from '../lib/map-vote-versions.js';

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

const versionsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

const versionParams = z.object({
  serverId: z.string().uuid(),
  versionId: z.string().uuid(),
});

const restoreBody = z.object({ drop_unknown_layers: z.boolean().optional() }).nullable().optional();

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

  /**
   * Current settings + pool as one snapshot, read back from the database
   * after a write so the version records what was actually stored rather
   * than what the request asked for.
   */
  async function currentSnapshot(serverId: string): Promise<MapVoteSnapshot> {
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
      candidates: candidates.map((row) => ({
        layer: row.layer,
        weight: row.weight,
        enabled: row.enabled,
      })),
    };
  }

  /**
   * Versions the screen's state into `config_versions`, the same history the
   * config editor writes. Best-effort by design: the settings are already
   * saved when this runs, and losing a history entry must not turn a
   * successful save into an error the operator has to retry.
   */
  async function versionMapVote(
    req: FastifyRequest,
    serverId: string,
    message: string,
  ): Promise<void> {
    try {
      await recordMapVoteVersion(app.db, {
        serverId,
        snapshot: await currentSnapshot(serverId),
        message,
        authorPlayerId: req.user?.playerId ?? null,
        authorIp: req.ip ?? null,
      });
    } catch (err) {
      req.log.warn(
        { err: (err as Error).message, serverId },
        'map-vote version not recorded; the save itself succeeded',
      );
    }
  }

  async function loadVersionRow(serverId: string, versionId: string) {
    return app.db.query.configVersions.findFirst({
      where: and(
        eq(configVersions.id, versionId),
        eq(configVersions.serverId, serverId),
        eq(configVersions.filename, MAP_VOTE_VERSION_FILENAME),
      ),
    });
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

      await versionMapVote(req, serverId, 'изменены правила автовыбора карты');
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

      await versionMapVote(req, serverId, `изменён пул слоёв (${candidates.length})`);
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

  // ---------------------------------------------------------------------
  // История изменений экрана — те же `config_versions`, что и у редактора
  // конфигов: цепочка версий, автор, сообщение, sha256 и откат.
  // ---------------------------------------------------------------------

  fast.get(
    '/api/v1/servers/:serverId/map-vote/versions',
    {
      schema: { params: serverIdParams, querystring: versionsQuery },
      config: { audit: false },
    },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const rows = await app.db
        .select({
          id: configVersions.id,
          sha256: configVersions.sha256,
          parent_version_id: configVersions.parentVersionId,
          author_player_id: configVersions.authorPlayerId,
          author_label: configVersions.authorLabel,
          author_name: players.canonicalName,
          message: configVersions.message,
          created_at: configVersions.createdAt,
        })
        .from(configVersions)
        .leftJoin(players, eq(players.id, configVersions.authorPlayerId))
        .where(
          and(
            eq(configVersions.serverId, req.params.serverId),
            eq(configVersions.filename, MAP_VOTE_VERSION_FILENAME),
          ),
        )
        .orderBy(desc(configVersions.createdAt))
        .limit(req.query.limit);

      return {
        filename: MAP_VOTE_VERSION_FILENAME,
        can_restore: req.user.permissions.squadPermissions.has('changemap'),
        versions: rows.map((row) => ({
          id: row.id,
          sha256: Buffer.from(row.sha256 as unknown as Buffer).toString('hex'),
          parent_version_id: row.parent_version_id,
          author: row.author_name ?? row.author_label ?? null,
          message: row.message,
          created_at: row.created_at.toISOString(),
        })),
      };
    },
  );

  fast.get(
    '/api/v1/servers/:serverId/map-vote/versions/:versionId',
    { schema: { params: versionParams }, config: { audit: false } },
    async (req, reply) => {
      if (!req.user) {
        reply.code(401);
        return { error: 'unauthenticated' };
      }
      if (!req.user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const row = await loadVersionRow(req.params.serverId, req.params.versionId);
      if (!row) {
        reply.code(404);
        return { error: 'version_not_found' };
      }
      return {
        id: row.id,
        created_at: row.createdAt.toISOString(),
        message: row.message,
        content: row.content,
        snapshot: parseMapVoteSnapshot(row.content),
      };
    },
  );

  fast.post(
    '/api/v1/servers/:serverId/map-vote/versions/:versionId/restore',
    {
      schema: { params: versionParams, body: restoreBody },
      config: { audit: false },
    },
    async (req, reply) => {
      const denied = requireChangemap(req, reply);
      if (denied) return denied;
      // biome-ignore lint/style/noNonNullAssertion: requireChangemap already 401s when req.user is missing
      const user = req.user!;
      const { serverId, versionId } = req.params;

      const row = await loadVersionRow(serverId, versionId);
      if (!row) {
        reply.code(404);
        return { error: 'version_not_found' };
      }
      const snapshot = parseMapVoteSnapshot(row.content);
      if (!snapshot) {
        reply.code(422);
        return { error: 'version_unreadable' };
      }

      const existing = await app.db.query.serverSettings.findFirst({
        where: eq(serverSettings.serverId, serverId),
      });
      if (!existing) {
        reply.code(404);
        return { error: 'settings_not_found' };
      }

      // A layer can leave the catalog between the save and the restore. Such a
      // pool would be silently unusable — the scheduler drops candidates whose
      // layer it cannot resolve — so say so instead, and only drop them when
      // the caller has seen the list and asked for it.
      const names = snapshot.candidates.map((candidate) => candidate.layer);
      const known = names.length
        ? await app.db.select({ name: layers.name }).from(layers).where(inArray(layers.name, names))
        : [];
      const knownNames = new Set(known.map((entry) => entry.name));
      const missing = names.filter((name) => !knownNames.has(name));
      if (missing.length > 0 && !req.body?.drop_unknown_layers) {
        reply.code(409);
        return { error: 'unknown_layers_in_version', layers: missing };
      }
      const restored = snapshot.candidates.filter((candidate) => knownNames.has(candidate.layer));

      await app.db.transaction(async (tx) => {
        await tx
          .update(serverSettings)
          .set({
            mapVoteEnabled: snapshot.enabled,
            mapVoteSelection: snapshot.selection,
            mapVoteLayerCooldown: snapshot.layer_cooldown,
            mapVoteMapCooldown: snapshot.map_cooldown,
            mapVoteBroadcastTemplate: snapshot.broadcast_template,
          })
          .where(eq(serverSettings.serverId, serverId));
        await tx.delete(mapVoteCandidates).where(eq(mapVoteCandidates.serverId, serverId));
        if (restored.length > 0) {
          await tx.insert(mapVoteCandidates).values(
            restored.map((candidate) => ({
              serverId,
              layer: candidate.layer,
              weight: candidate.weight,
              enabled: candidate.enabled,
              createdBy: user.playerId,
            })),
          );
        }
      });

      await versionMapVote(req, serverId, `откат к версии ${versionId.slice(0, 8)}`);
      await auditMapVoteWrite(req, reply, {
        actionType: 'server.map_vote.restore',
        serverId,
        after: { version_id: versionId, dropped_layers: missing, count: restored.length },
      });
      return { ok: true, count: restored.length, dropped_layers: missing };
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
