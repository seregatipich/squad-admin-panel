import { layers, matches } from '@squad/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type Redis from 'ioredis';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import { sendRconCommandViaWorker } from '../lib/rcon-worker-command.js';

const serverIdParams = z.object({ serverId: z.string().uuid() });
const mapActionBody = z.object({
  layer: z.string().trim().min(1).max(200),
  confirm_deprecated: z.boolean().optional(),
});

interface RconStatus {
  state?: string;
  current_map?: string;
  next_level?: string;
  next_layer?: string;
  game_mode?: string;
}

interface MapSide {
  layer: string;
  map: string | null;
  gamemode: string | null;
  deprecated: boolean;
}

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

async function readRconStatus(redis: Redis, serverId: string): Promise<RconStatus> {
  const raw = await redis.get(`rcon:status:${serverId}`);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as RconStatus;
  } catch {
    return {};
  }
}

/**
 * ROT-3 (#146): current/next-map widget backing the server detail page.
 *
 * `GET /map` is read-only (panelAccess gate) and joins the live RCON status
 * cached in redis (`rcon:status:<serverId>`, refreshed every ~30s by
 * worker-rcon's `ShowNextMap`/`ShowServerInfo` poll — see
 * apps/workers/rcon/src/supervisor.ts) against the ROT-1 layer catalog for
 * map/gamemode/deprecated metadata.
 *
 * The three POST actions require the `changemap` squad permission, enqueue
 * an RCON operator command via the worker-rcon command queue, write an audit
 * entry with the layer in the payload, and publish `server.map.changed` on
 * the live-bus for an instant widget refresh (the ≤30s RCON poll is the
 * fallback path).
 */
const serverMapRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function resolveLayerSide(
    layerName: string | undefined,
    gameModeFallback: string | undefined,
  ): Promise<MapSide | null> {
    if (!layerName) return null;
    const row = await app.db.query.layers.findFirst({ where: eq(layers.name, layerName) });
    return {
      layer: layerName,
      map: row?.map ?? null,
      gamemode: row?.gamemode ?? gameModeFallback ?? null,
      deprecated: row?.deprecated ?? false,
    };
  }

  async function auditMapAction(
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
    '/api/v1/servers/:serverId/map',
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

      const status = await readRconStatus(app.redis, serverId);
      const [current, next] = await Promise.all([
        resolveLayerSide(status.current_map, status.game_mode),
        resolveLayerSide(status.next_layer, undefined),
      ]);

      const openMatch = await app.db.query.matches.findFirst({
        where: and(eq(matches.serverId, serverId), isNull(matches.endedAt)),
        orderBy: desc(matches.startedAt),
      });

      return {
        current,
        next,
        match_started_at: openMatch?.startedAt.toISOString() ?? null,
      };
    },
  );

  fast.post(
    '/api/v1/servers/:serverId/map/next',
    { schema: { params: serverIdParams, body: mapActionBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = requireChangemap(req, reply);
      if (denied) return denied;
      // biome-ignore lint/style/noNonNullAssertion: requireChangemap already 401s when req.user is missing
      const user = req.user!;

      const { serverId } = req.params;
      const { layer, confirm_deprecated } = req.body;

      const layerRow = await app.db.query.layers.findFirst({ where: eq(layers.name, layer) });
      if (!layerRow) {
        reply.code(404);
        return { error: 'unknown_layer' };
      }
      if (layerRow.deprecated && !confirm_deprecated) {
        reply.code(409);
        return { error: 'deprecated_layer_confirmation_required' };
      }

      const outcome = await sendRconCommandViaWorker(app.redis, {
        serverId,
        command: 'AdminSetNextLayer',
        args: [layer],
        actorPlayerId: user.playerId,
      });

      if (!outcome.attempted) {
        reply.code(502);
        return { error: 'rcon_unavailable', reason: outcome.reason };
      }
      if (!outcome.ok) {
        reply.code(502);
        return { error: 'rcon_failed', reason: outcome.reason, detail: outcome.detail };
      }

      await patchNextLayer(app.redis, serverId, layer);

      await auditMapAction(req, reply, {
        actionType: 'server.map.set_next',
        serverId,
        after: { layer },
      });

      app.liveBus.publish({
        type: 'server.map.changed',
        ts: new Date().toISOString(),
        data: { server_id: serverId, action: 'server.map.set_next', layer },
      });

      return { ok: true, layer };
    },
  );

  fast.post(
    '/api/v1/servers/:serverId/map/change',
    { schema: { params: serverIdParams, body: mapActionBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = requireChangemap(req, reply);
      if (denied) return denied;
      // biome-ignore lint/style/noNonNullAssertion: requireChangemap already 401s when req.user is missing
      const user = req.user!;

      const { serverId } = req.params;
      const { layer, confirm_deprecated } = req.body;

      const layerRow = await app.db.query.layers.findFirst({ where: eq(layers.name, layer) });
      if (!layerRow) {
        reply.code(404);
        return { error: 'unknown_layer' };
      }
      if (layerRow.deprecated && !confirm_deprecated) {
        reply.code(409);
        return { error: 'deprecated_layer_confirmation_required' };
      }

      const outcome = await sendRconCommandViaWorker(app.redis, {
        serverId,
        command: 'AdminChangeLayer',
        args: [layer],
        actorPlayerId: user.playerId,
      });

      if (!outcome.attempted) {
        reply.code(502);
        return { error: 'rcon_unavailable', reason: outcome.reason };
      }
      if (!outcome.ok) {
        reply.code(502);
        return { error: 'rcon_failed', reason: outcome.reason, detail: outcome.detail };
      }

      await auditMapAction(req, reply, {
        actionType: 'server.map.change',
        serverId,
        after: { layer },
      });

      app.liveBus.publish({
        type: 'server.map.changed',
        ts: new Date().toISOString(),
        data: { server_id: serverId, action: 'server.map.change', layer },
      });

      return { ok: true, layer };
    },
  );

  fast.post(
    '/api/v1/servers/:serverId/map/end-match',
    { schema: { params: serverIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = requireChangemap(req, reply);
      if (denied) return denied;
      // biome-ignore lint/style/noNonNullAssertion: requireChangemap already 401s when req.user is missing
      const user = req.user!;
      const { serverId } = req.params;

      const status = await readRconStatus(app.redis, serverId);

      const outcome = await sendRconCommandViaWorker(app.redis, {
        serverId,
        command: 'AdminEndMatch',
        args: [],
        actorPlayerId: user.playerId,
      });

      if (!outcome.attempted) {
        reply.code(502);
        return { error: 'rcon_unavailable', reason: outcome.reason };
      }
      if (!outcome.ok) {
        reply.code(502);
        return { error: 'rcon_failed', reason: outcome.reason, detail: outcome.detail };
      }

      await auditMapAction(req, reply, {
        actionType: 'server.map.end_match',
        serverId,
        after: { layer: status.current_map ?? null },
      });

      app.liveBus.publish({
        type: 'server.map.changed',
        ts: new Date().toISOString(),
        data: { server_id: serverId, action: 'server.map.end_match', layer: null },
      });

      return { ok: true };
    },
  );
};

async function patchNextLayer(redis: Redis, serverId: string, layer: string): Promise<void> {
  const key = `rcon:status:${serverId}`;
  const raw = await redis.get(key);
  if (!raw) return;
  try {
    const status = JSON.parse(raw) as Record<string, unknown>;
    status.next_layer = layer;
    // 5-minute TTL, matching worker-rcon's own writeStatus — the next real
    // poll (≤30s) overwrites this with the actual game state regardless.
    await redis.set(key, JSON.stringify(status), 'EX', 300);
  } catch {
    // best-effort optimistic patch only; the poll loop is the source of truth
  }
}

export default serverMapRoutes;
