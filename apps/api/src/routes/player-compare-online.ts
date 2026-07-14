import { playerSessions, players, servers } from '@squad/db/schema';
import { and, asc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { computeCoPresence, type RawSession } from '../lib/compare-online.js';

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 31;
const SESSION_WINDOW_CAP = 2000;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const compareQuery = z.object({
  other: z.string().uuid(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

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

interface ResolvedWindow {
  fromDay: string;
  toDay: string;
  windowStartMs: number;
  windowEndMs: number;
}

type WindowError = { error: 'invalid_window' | 'window_too_large' };

/**
 * Resolves and validates the `from`/`to` querystring pair into a concrete
 * `[windowStartMs, windowEndMs)` millisecond range.
 *
 * Defaults `to` to today (UTC) and `from` to `to - 6 days` (a trailing
 * 7-day window), matching the PRES-4 presence calendar's default. Rejects
 * an inverted range (`from` after `to`) and any span over
 * {@link MAX_WINDOW_DAYS} days (inclusive of both endpoints).
 */
function resolveWindow(
  from: string | undefined,
  to: string | undefined,
): ResolvedWindow | WindowError {
  const toDay = to ?? new Date().toISOString().slice(0, 10);
  const toMidnight = Date.parse(`${toDay}T00:00:00.000Z`);
  const fromDay =
    from ?? new Date(toMidnight - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const fromMidnight = Date.parse(`${fromDay}T00:00:00.000Z`);

  if (!Number.isFinite(fromMidnight) || !Number.isFinite(toMidnight) || fromMidnight > toMidnight) {
    return { error: 'invalid_window' };
  }

  const spanDays = (toMidnight - fromMidnight) / DAY_MS + 1;
  if (spanDays > MAX_WINDOW_DAYS) {
    return { error: 'window_too_large' };
  }

  return {
    fromDay,
    toDay,
    windowStartMs: fromMidnight,
    windowEndMs: toMidnight + DAY_MS,
  };
}

const playerCompareOnlineRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/compare-online',
    { schema: { params: playerIdParams, querystring: compareQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { playerId } = req.params;
      const { other } = req.query;

      if (other === playerId) {
        reply.code(422);
        return { error: 'same_player' };
      }

      const resolved = resolveWindow(req.query.from, req.query.to);
      if ('error' in resolved) {
        reply.code(422);
        return resolved;
      }
      const { fromDay, toDay, windowStartMs, windowEndMs } = resolved;
      const windowStart = new Date(windowStartMs);
      const windowEnd = new Date(windowEndMs);

      const [playerA, playerB] = await Promise.all([
        app.db
          .select({
            id: players.id,
            canonicalName: players.canonicalName,
            steamId64: players.steamId64,
          })
          .from(players)
          .where(eq(players.id, playerId))
          .limit(1)
          .then((rows) => rows[0]),
        app.db
          .select({
            id: players.id,
            canonicalName: players.canonicalName,
            steamId64: players.steamId64,
          })
          .from(players)
          .where(eq(players.id, other))
          .limit(1)
          .then((rows) => rows[0]),
      ]);
      if (!playerA || !playerB) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const [sessionRowsA, sessionRowsB] = await Promise.all([
        fetchSessionsInWindow(app, playerId, windowStart, windowEnd),
        fetchSessionsInWindow(app, other, windowStart, windowEnd),
      ]);

      const nowMs = Date.now();
      const overlap = computeCoPresence(
        sessionRowsA as RawSession[],
        sessionRowsB as RawSession[],
        windowStartMs,
        windowEndMs,
        nowMs,
      );

      return {
        window: { from: fromDay, to: toDay },
        players: [
          {
            id: playerA.id,
            canonical_name: playerA.canonicalName,
            steam_id64: playerA.steamId64 ? playerA.steamId64.toString() : null,
          },
          {
            id: playerB.id,
            canonical_name: playerB.canonicalName,
            steam_id64: playerB.steamId64 ? playerB.steamId64.toString() : null,
          },
        ],
        sessions: {
          a: sessionRowsA.map(toSessionPayload),
          b: sessionRowsB.map(toSessionPayload),
        },
        overlap: {
          total_seconds: overlap.totalOverlapSeconds,
          concurrent_count: overlap.concurrentCount,
          intervals: overlap.concurrentIntervals.map((interval) => ({
            from: new Date(interval.fromMs).toISOString(),
            to: new Date(interval.toMs).toISOString(),
          })),
        },
      };
    },
  );
};

interface SessionRow {
  id: bigint;
  serverId: string;
  serverName: string | null;
  serverSlug: string | null;
  mode: string;
  connectedAt: Date;
  disconnectedAt: Date | null;
}

/**
 * Sessions overlapping `[windowStart, windowEnd)`, ordered oldest-first and
 * capped at {@link SESSION_WINDOW_CAP} to bound response size — same
 * predicate and cap as the PRES-4 `/presence` endpoint.
 */
async function fetchSessionsInWindow(
  app: FastifyInstance,
  playerId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<SessionRow[]> {
  return app.db
    .select({
      id: playerSessions.id,
      serverId: playerSessions.serverId,
      serverName: servers.displayName,
      serverSlug: servers.slug,
      mode: playerSessions.mode,
      connectedAt: playerSessions.connectedAt,
      disconnectedAt: playerSessions.disconnectedAt,
    })
    .from(playerSessions)
    .leftJoin(servers, eq(servers.id, playerSessions.serverId))
    .where(
      and(
        eq(playerSessions.playerId, playerId),
        lt(playerSessions.connectedAt, windowEnd),
        or(isNull(playerSessions.disconnectedAt), gt(playerSessions.disconnectedAt, windowStart)),
      ),
    )
    .orderBy(asc(playerSessions.connectedAt))
    .limit(SESSION_WINDOW_CAP);
}

function toSessionPayload(row: SessionRow) {
  return {
    id: row.id.toString(),
    server_id: row.serverId,
    server_name: row.serverName,
    server_slug: row.serverSlug,
    mode: row.mode,
    connected_at: row.connectedAt.toISOString(),
    disconnected_at: row.disconnectedAt ? row.disconnectedAt.toISOString() : null,
  };
}

export default playerCompareOnlineRoutes;
