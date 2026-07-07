import {
  COPLAY_DEFAULT_MIN_OVERLAP_SECONDS,
  COPLAY_DEFAULT_MIN_SHARED_SESSIONS,
  COPLAY_WINDOW_DAYS,
} from '@squad/db';
import { coplaySettings } from '@squad/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const DAY_MS = 86_400_000;
const TOP_PARTNERS_LIMIT = 20;

const playerIdParams = z.object({ playerId: z.string().uuid() });

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

interface TotalsRow {
  partner_id: string;
  partner_name: string | null;
  overlap_seconds: string | number;
  shared_session_count: string | number;
}

interface ServerRow {
  partner_id: string;
  server_id: string;
  server_name: string | null;
  server_slug: string | null;
  overlap_seconds: string | number;
  shared_session_count: string | number;
}

/**
 * Co-play graph routes (ALT-3). Serves the "часто играет с" list for a player:
 * the top {@link TOP_PARTNERS_LIMIT} co-play partners over the rolling
 * {@link COPLAY_WINDOW_DAYS}-day window, aggregated across all servers with a
 * per-server breakdown, filtered by the configurable noise-floor thresholds.
 * Gated on `panel_access` — IP data is never involved.
 */
const playerCoplayRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/coplay',
    { schema: { params: playerIdParams }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { playerId } = req.params;

      const [settings] = await app.db
        .select({
          minShared: coplaySettings.minSharedSessions,
          minOverlap: coplaySettings.minOverlapSeconds,
        })
        .from(coplaySettings)
        .where(eq(coplaySettings.id, 1))
        .limit(1);

      const minShared = settings?.minShared ?? COPLAY_DEFAULT_MIN_SHARED_SESSIONS;
      const minOverlap = settings?.minOverlap ?? COPLAY_DEFAULT_MIN_OVERLAP_SECONDS;

      const toDay = new Date().toISOString().slice(0, 10);
      const fromDay = new Date(
        Date.parse(`${toDay}T00:00:00.000Z`) - (COPLAY_WINDOW_DAYS - 1) * DAY_MS,
      )
        .toISOString()
        .slice(0, 10);

      const totals = (await app.db.execute(sql`
        WITH windowed AS (
          SELECT
            CASE WHEN pc.player_a_id = ${playerId} THEN pc.player_b_id ELSE pc.player_a_id END
              AS partner_id,
            pc.overlap_seconds,
            pc.shared_session_count
          FROM player_coplay pc
          WHERE (pc.player_a_id = ${playerId} OR pc.player_b_id = ${playerId})
            AND pc.window_start >= ${fromDay}::date
        )
        SELECT
          w.partner_id,
          p.canonical_name AS partner_name,
          SUM(w.overlap_seconds)::bigint AS overlap_seconds,
          SUM(w.shared_session_count)::bigint AS shared_session_count
        FROM windowed w
        LEFT JOIN players p ON p.id = w.partner_id
        GROUP BY w.partner_id, p.canonical_name
        HAVING SUM(w.shared_session_count) >= ${minShared}
           AND SUM(w.overlap_seconds) >= ${minOverlap}
        ORDER BY SUM(w.overlap_seconds) DESC, w.partner_id
        LIMIT ${TOP_PARTNERS_LIMIT}
      `)) as unknown as TotalsRow[];

      const topPartnerIds = new Set(totals.map((row) => row.partner_id));

      const perServer = topPartnerIds.size
        ? ((await app.db.execute(sql`
            WITH windowed AS (
              SELECT
                CASE WHEN pc.player_a_id = ${playerId} THEN pc.player_b_id ELSE pc.player_a_id END
                  AS partner_id,
                pc.server_id,
                pc.overlap_seconds,
                pc.shared_session_count
              FROM player_coplay pc
              WHERE (pc.player_a_id = ${playerId} OR pc.player_b_id = ${playerId})
                AND pc.window_start >= ${fromDay}::date
            )
            SELECT
              w.partner_id,
              w.server_id,
              s.display_name AS server_name,
              s.slug AS server_slug,
              SUM(w.overlap_seconds)::bigint AS overlap_seconds,
              SUM(w.shared_session_count)::bigint AS shared_session_count
            FROM windowed w
            LEFT JOIN servers s ON s.id = w.server_id
            GROUP BY w.partner_id, w.server_id, s.display_name, s.slug
            ORDER BY SUM(w.overlap_seconds) DESC
          `)) as unknown as ServerRow[])
        : [];

      const byPartner = new Map<
        string,
        Array<{
          server_id: string;
          server_name: string | null;
          server_slug: string | null;
          overlap_seconds: number;
          shared_session_count: number;
        }>
      >();
      for (const row of perServer) {
        if (!topPartnerIds.has(row.partner_id)) continue;
        const list = byPartner.get(row.partner_id) ?? [];
        list.push({
          server_id: row.server_id,
          server_name: row.server_name,
          server_slug: row.server_slug,
          overlap_seconds: Number(row.overlap_seconds),
          shared_session_count: Number(row.shared_session_count),
        });
        byPartner.set(row.partner_id, list);
      }

      return {
        window: { from: fromDay, to: toDay, days: COPLAY_WINDOW_DAYS },
        thresholds: { min_shared_sessions: minShared, min_overlap_seconds: minOverlap },
        partners: totals.map((row) => ({
          player_id: row.partner_id,
          player_name: row.partner_name,
          overlap_seconds: Number(row.overlap_seconds),
          shared_session_count: Number(row.shared_session_count),
          by_server: byPartner.get(row.partner_id) ?? [],
        })),
      };
    },
  );
};

export default playerCoplayRoutes;
