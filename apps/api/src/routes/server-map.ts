import { layers, matches } from '@squad/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type Redis from 'ioredis';
import { z } from 'zod';
import { requireSquadPermission } from '../lib/map-guards.js';
import { sendRconCommandViaWorker } from '../lib/rcon-worker-command.js';

const serverIdParams = z.object({ serverId: z.string().uuid() });
const mapActionBody = z.object({
  layer: z.string().trim().min(1).max(200),
  confirm_deprecated: z.boolean().optional(),
});

// #307: the worker-rcon status blob is untrusted input read back out of
// Redis — validate its shape instead of an unchecked `as RconStatus`, so a
// malformed value can't reach `eq(layers.name, …)` or patchNextLayer as a
// non-string.
const rconStatusSchema = z
  .object({
    state: z.string().optional(),
    current_map: z.string().optional(),
    next_level: z.string().optional(),
    next_layer: z.string().optional(),
    game_mode: z.string().optional(),
  })
  .partial();
type RconStatus = z.infer<typeof rconStatusSchema>;

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
  return requireSquadPermission(req, reply, 'changemap');
}

async function readRconStatus(redis: Redis, serverId: string): Promise<RconStatus> {
  const raw = await redis.get(`rcon:status:${serverId}`);
  if (!raw) return {};
  try {
    const parsed = rconStatusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
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
  fast.get(
    '/api/v1/servers/:serverId/map',
    { schema: { params: serverIdParams }, config: { permissions: ['server:view'], audit: false } },
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
    {
      schema: { params: serverIdParams, body: mapActionBody },
      config: { audit: { action: 'server.map.set_next', resource: 'server' } },
    },
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

      req.auditSnapshots = { after: { layer } };

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
    {
      schema: { params: serverIdParams, body: mapActionBody },
      config: { audit: { action: 'server.map.change', resource: 'server' } },
    },
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

      req.auditSnapshots = { after: { layer } };

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
    {
      schema: { params: serverIdParams },
      config: { audit: { action: 'server.map.end_match', resource: 'server' } },
    },
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

      req.auditSnapshots = { after: { layer: status.current_map ?? null } };

      app.liveBus.publish({
        type: 'server.map.changed',
        ts: new Date().toISOString(),
        data: { server_id: serverId, action: 'server.map.end_match', layer: null },
      });

      return { ok: true };
    },
  );
};

// #304: a plain GET, patch-in-JS, SET raced worker-rcon's own status writes
// (a status written between our GET and SET was clobbered by our stale
// snapshot) and always reset the TTL to 300s — extending a dead worker's
// stale 'connected' status instead of letting it expire. The Lua script
// executes as one atomic step on the Redis server, closing the race, and
// `KEEPTTL` leaves the poll-driven expiry alone.
const PATCH_NEXT_LAYER_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, status = pcall(cjson.decode, raw)
if not ok or type(status) ~= 'table' then return 0 end
status.next_layer = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(status), 'KEEPTTL')
return 1
`;

async function patchNextLayer(redis: Redis, serverId: string, layer: string): Promise<void> {
  const key = `rcon:status:${serverId}`;
  try {
    await redis.eval(PATCH_NEXT_LAYER_SCRIPT, 1, key, layer);
  } catch {
    // best-effort optimistic patch only; the poll loop is the source of truth
  }
}

export default serverMapRoutes;
