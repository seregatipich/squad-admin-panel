import type { VoteAnalytics } from '@squad/shared-types';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { csvCell } from '../lib/csv.js';
import { panelGuard } from '../lib/panel-guard.js';

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 366;
const RANK_LIMIT_DEFAULT = 10;
const RANK_LIMIT_MAX = 50;
const DAY_MS = 86_400_000;

export const SERIAL_SKIPPER_THRESHOLD = 5;
export const SERIAL_SKIPPER_WINDOW_DAYS = 7;

const dashboardQuery = z.object({
  server_id: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.coerce.number().int().min(1).max(RANK_LIMIT_MAX).default(RANK_LIMIT_DEFAULT),
});

const playerParams = z.object({ playerId: z.string().uuid() });

interface ResolvedWindow {
  from: Date;
  to: Date;
}

function resolveWindow(fromRaw?: string, toRaw?: string): ResolvedWindow {
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  const span = to.getTime() - from.getTime();
  if (span < 0) return { from: to, to };
  if (span > MAX_WINDOW_DAYS * DAY_MS) {
    return { from: new Date(to.getTime() - MAX_WINDOW_DAYS * DAY_MS), to };
  }
  return { from, to };
}

function passRate(passed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((passed / total) * 1000) / 10;
}

function toCsv(payload: VoteAnalytics): string {
  const lines: string[] = ['section,key,value'];
  const push = (section: string, key: string, value: string | number) => {
    lines.push([csvCell(section), csvCell(key), csvCell(String(value))].join(','));
  };
  push('meta', 'server_id', payload.server_id ?? 'all');
  push('meta', 'from', payload.from);
  push('meta', 'to', payload.to);
  push('summary', 'total_votes', payload.summary.total_votes);
  push('summary', 'passed', payload.summary.passed);
  push('summary', 'failed', payload.summary.failed);
  push('summary', 'cancelled', payload.summary.cancelled);
  push('summary', 'pass_rate', payload.summary.pass_rate);
  for (const row of payload.pass_rate_by_server) {
    push('pass_rate_by_server', row.server_name ?? row.server_id, `${row.passed}/${row.total}`);
  }
  for (const row of payload.pass_rate_by_map) {
    push('pass_rate_by_map', row.map, `${row.passed}/${row.total}`);
  }
  for (const row of payload.trend) push('trend', row.day, row.count);
  for (const row of payload.top_initiators) {
    push('top_initiator', row.nickname ?? row.player_id, `${row.passed}/${row.initiated}`);
  }
  for (const row of payload.by_hour) push('by_hour', String(row.hour), row.count);
  for (const row of payload.serial_skippers) {
    push('serial_skipper', row.nickname ?? row.player_id, row.skip_count);
  }
  return `${lines.join('\r\n')}\r\n`;
}

const voteAnalyticsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/analytics/votes',
    {
      config: { permissions: ['events:view'], audit: false },
      schema: { querystring: dashboardQuery },
    },
    async (req, reply) => {
      const guard = panelGuard(req, reply);
      if (guard) return guard;

      const serverId = req.query.server_id ?? null;
      const { from, to } = resolveWindow(req.query.from, req.query.to);
      const fromIso = from.toISOString();
      const toIso = to.toISOString();
      const limit = req.query.limit;

      // Same rule as the player card: the threshold applies to the trailing
      // SERIAL_SKIPPER_WINDOW_DAYS ending at `to`, clamped to a shorter selected window.
      const skipperWindowStartIso = new Date(
        Math.max(from.getTime(), to.getTime() - SERIAL_SKIPPER_WINDOW_DAYS * DAY_MS),
      ).toISOString();

      const voteFilter = sql`v.started_at >= ${fromIso}::timestamptz
        AND v.started_at < ${toIso}::timestamptz
        AND (${serverId}::uuid IS NULL OR v.server_id = ${serverId}::uuid)`;

      // The seven aggregates are independent reads of game_votes, so they run concurrently.
      const [
        summaryRows,
        byServerRows,
        byMapRows,
        trendRows,
        initiatorRows,
        hourRows,
        skipperRows,
      ] = await Promise.all([
        app.db.execute<{
          total_votes: number;
          passed: number;
          failed: number;
          cancelled: number;
        }>(sql`
        SELECT count(*)::int AS total_votes,
               count(*) FILTER (WHERE v.result = 'passed')::int AS passed,
               count(*) FILTER (WHERE v.result = 'failed')::int AS failed,
               count(*) FILTER (WHERE v.result = 'cancelled')::int AS cancelled
        FROM game_votes v
        WHERE ${voteFilter}
      `),
        app.db.execute<{
          server_id: string;
          server_name: string | null;
          total: number;
          passed: number;
        }>(sql`
        SELECT v.server_id AS server_id,
               s.display_name AS server_name,
               count(*)::int AS total,
               count(*) FILTER (WHERE v.result = 'passed')::int AS passed
        FROM game_votes v
        LEFT JOIN servers s ON s.id = v.server_id
        WHERE ${voteFilter}
        GROUP BY v.server_id, s.display_name
        ORDER BY total DESC, server_name ASC
      `),
        app.db.execute<{ map: string; total: number; passed: number }>(sql`
        SELECT v.map_current AS map,
               count(*)::int AS total,
               count(*) FILTER (WHERE v.result = 'passed')::int AS passed
        FROM game_votes v
        WHERE ${voteFilter}
          AND v.vote_type = 'map_skip'
          AND v.map_current IS NOT NULL
        GROUP BY v.map_current
        ORDER BY total DESC, map ASC
        LIMIT ${limit}
      `),
        app.db.execute<{ day: string; count: number }>(sql`
        SELECT to_char(date_trunc('day', v.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
               count(*)::int AS count
        FROM game_votes v
        WHERE ${voteFilter}
        GROUP BY 1
        ORDER BY 1
      `),
        app.db.execute<{
          player_id: string;
          nickname: string | null;
          initiated: number;
          passed: number;
        }>(sql`
        SELECT v.initiator_player_id AS player_id,
               p.canonical_name AS nickname,
               count(*)::int AS initiated,
               count(*) FILTER (WHERE v.result = 'passed')::int AS passed
        FROM game_votes v
        JOIN players p ON p.id = v.initiator_player_id
        WHERE ${voteFilter} AND v.initiator_player_id IS NOT NULL
        GROUP BY v.initiator_player_id, p.canonical_name
        ORDER BY initiated DESC, passed DESC, nickname ASC
        LIMIT ${limit}
      `),
        app.db.execute<{ hour: number; count: number }>(sql`
        SELECT extract(hour FROM v.started_at AT TIME ZONE 'UTC')::int AS hour,
               count(*)::int AS count
        FROM game_votes v
        WHERE ${voteFilter}
        GROUP BY 1
      `),
        app.db.execute<{ player_id: string; nickname: string | null; skip_count: number }>(sql`
        SELECT v.initiator_player_id AS player_id,
               p.canonical_name AS nickname,
               count(*)::int AS skip_count
        FROM game_votes v
        JOIN players p ON p.id = v.initiator_player_id
        WHERE ${voteFilter}
          AND v.started_at >= ${skipperWindowStartIso}::timestamptz
          AND v.vote_type = 'map_skip'
          AND v.initiator_player_id IS NOT NULL
        GROUP BY v.initiator_player_id, p.canonical_name
        HAVING count(*) >= ${SERIAL_SKIPPER_THRESHOLD}
        ORDER BY skip_count DESC, nickname ASC
        LIMIT ${RANK_LIMIT_MAX}
      `),
      ]);

      const summaryRow = summaryRows[0];
      const totalVotes = Number(summaryRow?.total_votes ?? 0);
      const passedVotes = Number(summaryRow?.passed ?? 0);

      const hourMap = new Map<number, number>();
      for (const row of hourRows) hourMap.set(Number(row.hour), Number(row.count));

      const payload: VoteAnalytics = {
        server_id: serverId,
        from: fromIso,
        to: toIso,
        summary: {
          total_votes: totalVotes,
          passed: passedVotes,
          failed: Number(summaryRow?.failed ?? 0),
          cancelled: Number(summaryRow?.cancelled ?? 0),
          pass_rate: passRate(passedVotes, totalVotes),
        },
        pass_rate_by_server: byServerRows.map((row) => {
          const total = Number(row.total);
          const passed = Number(row.passed);
          return {
            server_id: row.server_id,
            server_name: row.server_name,
            total,
            passed,
            pass_rate: passRate(passed, total),
          };
        }),
        pass_rate_by_map: byMapRows.map((row) => {
          const total = Number(row.total);
          const passed = Number(row.passed);
          return { map: row.map, total, passed, pass_rate: passRate(passed, total) };
        }),
        trend: trendRows.map((row) => ({ day: row.day, count: Number(row.count) })),
        top_initiators: initiatorRows.map((row) => {
          const initiated = Number(row.initiated);
          const passed = Number(row.passed);
          return {
            player_id: row.player_id,
            nickname: row.nickname,
            initiated,
            passed,
            success_ratio: passRate(passed, initiated),
          };
        }),
        by_hour: Array.from({ length: 24 }, (_, hour) => ({
          hour,
          count: hourMap.get(hour) ?? 0,
        })),
        serial_skippers: skipperRows.map((row) => ({
          player_id: row.player_id,
          nickname: row.nickname,
          skip_count: Number(row.skip_count),
        })),
        serial_skipper_window_days: SERIAL_SKIPPER_WINDOW_DAYS,
      };

      if (req.query.format === 'csv') {
        void reply.header('content-type', 'text/csv; charset=utf-8');
        void reply.header('content-disposition', 'attachment; filename="vote-analytics.csv"');
        return toCsv(payload);
      }

      return payload;
    },
  );

  fast.get(
    '/api/v1/players/:playerId/vote-stats',
    { config: { permissions: ['player:view'], audit: false }, schema: { params: playerParams } },
    async (req, reply) => {
      const guard = panelGuard(req, reply);
      if (guard) return guard;

      const playerId = req.params.playerId;
      const windowStart = new Date(Date.now() - SERIAL_SKIPPER_WINDOW_DAYS * DAY_MS).toISOString();

      const rows = (await app.db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM game_votes gv WHERE gv.initiator_player_id = ${playerId}::uuid)
            AS initiated,
          (SELECT count(*)::int FROM game_vote_ballots gb WHERE gb.player_id = ${playerId}::uuid)
            AS participated,
          (SELECT count(*)::int FROM game_votes gv
             WHERE gv.initiator_player_id = ${playerId}::uuid
               AND gv.vote_type = 'map_skip'
               AND gv.started_at >= ${windowStart}::timestamptz)
            AS recent_skips
      `)) as unknown as Array<{ initiated: number; participated: number; recent_skips: number }>;

      const row = rows[0];
      const recentSkips = Number(row?.recent_skips ?? 0);

      return {
        player_id: playerId,
        initiated: Number(row?.initiated ?? 0),
        participated: Number(row?.participated ?? 0),
        serial_skipper: {
          flagged: recentSkips >= SERIAL_SKIPPER_THRESHOLD,
          skip_count: recentSkips,
          threshold: SERIAL_SKIPPER_THRESHOLD,
          window_days: SERIAL_SKIPPER_WINDOW_DAYS,
        },
      };
    },
  );
};

export default voteAnalyticsRoutes;
