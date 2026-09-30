import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { csvCell } from '../lib/csv.js';
import { resolveWindow, type WindowBounds } from './analytics.js';

const REPORT_WINDOW_BOUNDS: WindowBounds = { defaultDays: 30, maxDays: 366 };
const RANK_LIMIT_DEFAULT = 10;
const RANK_LIMIT_MAX = 50;
const DAY_MS = 86_400_000;
const TARGET_WINDOW_SHORT_DAYS = 30;
const TARGET_WINDOW_LONG_DAYS = 90;

const analyticsQuery = z.object({
  server_id: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.coerce.number().int().min(1).max(RANK_LIMIT_MAX).default(RANK_LIMIT_DEFAULT),
});

/**
 * `panel_access` first, like every other reports route (`report-actions.ts`,
 * `reports.ts`): `can_handle_reports` alone does not depend on it, so a role
 * that lost panel access must not keep reading moderator performance data.
 */
function reportsGuard(req: FastifyRequest, reply: FastifyReply): { error: string } | null {
  if (!req.user) {
    reply.code(401);
    return { error: 'unauthenticated' };
  }
  if (!req.user.permissions.panelAccess || !req.user.permissions.canHandleReports) {
    reply.code(403);
    return { error: 'forbidden' };
  }
  return null;
}

/*
 * Row shapes of the raw analytics queries. Postgres returns `numeric`
 * aggregates (avg, percentile_cont) as strings, hence `number | string`;
 * every value is normalised with `Number()` when the payload is built.
 */
interface SummaryRow extends Record<string, unknown> {
  total: number;
  pending: number;
  in_review: number;
  resolved: number;
  rejected: number;
  avg_resolution_seconds: number | string | null;
  median_resolution_seconds: number | string | null;
}

interface TrendRow extends Record<string, unknown> {
  day: string;
  count: number;
}

interface ByServerRow extends Record<string, unknown> {
  server_id: string;
  server_name: string | null;
  total: number;
  resolved: number;
  rejected: number;
}

interface ByHandlerRow extends Record<string, unknown> {
  player_id: string;
  name: string | null;
  handled: number;
  resolved: number;
  rejected: number;
  avg_resolution_seconds: number | string | null;
}

interface TopTargetRow extends Record<string, unknown> {
  player_id: string;
  name: string | null;
  count_30d: number;
  count_90d: number;
}

interface TopReporterRow extends Record<string, unknown> {
  player_id: string;
  name: string | null;
  total: number;
  resolved: number;
  rejected: number;
  confirmed: number;
  accuracy: number;
  trusted: boolean;
  spam_flagged: boolean;
}

interface ReportAnalyticsPayload {
  server_id: string | null;
  from: string;
  to: string;
  summary: {
    total: number;
    by_status: { pending: number; in_review: number; resolved: number; rejected: number };
    avg_resolution_seconds: number | null;
    median_resolution_seconds: number | null;
  };
  trend: Array<{ day: string; count: number }>;
  by_server: Array<{
    server_id: string;
    server_name: string | null;
    total: number;
    resolved: number;
    rejected: number;
  }>;
  by_handler: Array<{
    player_id: string;
    name: string | null;
    handled: number;
    resolved: number;
    rejected: number;
    avg_resolution_seconds: number | null;
  }>;
  top_targets: Array<{
    player_id: string;
    name: string | null;
    count_30d: number;
    count_90d: number;
  }>;
  top_reporters: Array<{
    player_id: string;
    name: string | null;
    total: number;
    resolved: number;
    rejected: number;
    confirmed: number;
    accuracy: number;
    trusted: boolean;
    spam_flagged: boolean;
  }>;
}

function toCsv(payload: ReportAnalyticsPayload): string {
  const lines: string[] = ['section,key,value'];
  const push = (section: string, key: string, value: string | number) => {
    lines.push([csvCell(section), csvCell(key), csvCell(String(value))].join(','));
  };
  push('meta', 'server_id', payload.server_id ?? 'all');
  push('meta', 'from', payload.from);
  push('meta', 'to', payload.to);
  push('summary', 'total', payload.summary.total);
  push('summary', 'pending', payload.summary.by_status.pending);
  push('summary', 'in_review', payload.summary.by_status.in_review);
  push('summary', 'resolved', payload.summary.by_status.resolved);
  push('summary', 'rejected', payload.summary.by_status.rejected);
  push('summary', 'avg_resolution_seconds', payload.summary.avg_resolution_seconds ?? '');
  push('summary', 'median_resolution_seconds', payload.summary.median_resolution_seconds ?? '');
  for (const row of payload.trend) push('trend', row.day, row.count);
  for (const row of payload.by_server) {
    push(
      'by_server',
      row.server_name ?? row.server_id,
      `total=${row.total} resolved=${row.resolved} rejected=${row.rejected}`,
    );
  }
  for (const row of payload.by_handler) {
    push(
      'by_handler',
      row.name ?? row.player_id,
      `handled=${row.handled} resolved=${row.resolved} rejected=${row.rejected} avg_resolution_seconds=${row.avg_resolution_seconds ?? ''}`,
    );
  }
  for (const row of payload.top_targets) {
    push('top_target', row.name ?? row.player_id, `30d=${row.count_30d} 90d=${row.count_90d}`);
  }
  for (const row of payload.top_reporters) {
    push(
      'top_reporter',
      row.name ?? row.player_id,
      `total=${row.total} accuracy=${row.accuracy} trusted=${row.trusted} spam_flagged=${row.spam_flagged}`,
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * REPORT-5 (#115) report analytics: SLA/status/handler breakdowns, trend,
 * top targets (fixed 30/90d windows), and the reporter ranking for the
 * requested server/window with each reporter's trust flags from
 * `reporter_stats`. Modeled on GET /api/v1/analytics/votes
 * (vote-analytics.ts). Gated by `panelAccess` and `can_handle_reports`
 * since this exposes reporter/handler performance data.
 */
const reportAnalyticsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/analytics/reports',
    { config: { audit: false }, schema: { querystring: analyticsQuery } },
    async (req, reply) => {
      const guard = reportsGuard(req, reply);
      if (guard) return guard;

      const serverId = req.query.server_id ?? null;
      const { from, to } = resolveWindow(req.query.from, req.query.to, REPORT_WINDOW_BOUNDS);
      const fromIso = from.toISOString();
      const toIso = to.toISOString();
      const limit = req.query.limit;

      const reportFilter = sql`pr.created_at >= ${fromIso}::timestamptz
        AND pr.created_at < ${toIso}::timestamptz
        AND (${serverId}::uuid IS NULL OR pr.server_id = ${serverId}::uuid)`;

      const shortSince = new Date(Date.now() - TARGET_WINDOW_SHORT_DAYS * DAY_MS).toISOString();
      const longSince = new Date(Date.now() - TARGET_WINDOW_LONG_DAYS * DAY_MS).toISOString();

      // The six sections are independent reads, so they run concurrently.
      const [summaryRows, trendRows, byServerRows, byHandlerRows, topTargetRows, topReporterRows] =
        await Promise.all([
          app.db.execute<SummaryRow>(sql`
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE pr.status = 'pending')::int AS pending,
            count(*) FILTER (WHERE pr.status = 'in_review')::int AS in_review,
            count(*) FILTER (WHERE pr.status = 'resolved')::int AS resolved,
            count(*) FILTER (WHERE pr.status = 'rejected')::int AS rejected,
            avg(extract(epoch FROM pr.resolved_at - pr.created_at))
              FILTER (WHERE pr.resolved_at IS NOT NULL) AS avg_resolution_seconds,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM pr.resolved_at - pr.created_at))
              FILTER (WHERE pr.resolved_at IS NOT NULL) AS median_resolution_seconds
          FROM player_reports pr
          WHERE ${reportFilter}
        `),
          app.db.execute<TrendRow>(sql`
          SELECT to_char(date_trunc('day', pr.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                 count(*)::int AS count
          FROM player_reports pr
          WHERE ${reportFilter}
          GROUP BY 1
          ORDER BY 1
        `),
          app.db.execute<ByServerRow>(sql`
          SELECT pr.server_id AS server_id,
                 s.display_name AS server_name,
                 count(*)::int AS total,
                 count(*) FILTER (WHERE pr.status = 'resolved')::int AS resolved,
                 count(*) FILTER (WHERE pr.status = 'rejected')::int AS rejected
          FROM player_reports pr
          LEFT JOIN servers s ON s.id = pr.server_id
          WHERE ${reportFilter}
          GROUP BY pr.server_id, s.display_name
          ORDER BY total DESC, server_name ASC
        `),
          app.db.execute<ByHandlerRow>(sql`
          SELECT pr.handler_player_id AS player_id,
                 p.canonical_name AS name,
                 count(*)::int AS handled,
                 count(*) FILTER (WHERE pr.status = 'resolved')::int AS resolved,
                 count(*) FILTER (WHERE pr.status = 'rejected')::int AS rejected,
                 avg(extract(epoch FROM pr.resolved_at - pr.created_at))
                   FILTER (WHERE pr.resolved_at IS NOT NULL) AS avg_resolution_seconds
          FROM player_reports pr
          JOIN players p ON p.id = pr.handler_player_id
          WHERE ${reportFilter} AND pr.handler_player_id IS NOT NULL
          GROUP BY pr.handler_player_id, p.canonical_name
          ORDER BY handled DESC, name ASC
          LIMIT ${limit}
        `),
          app.db.execute<TopTargetRow>(sql`
          SELECT pr.target_player_id AS player_id,
                 p.canonical_name AS name,
                 count(*) FILTER (WHERE pr.created_at >= ${shortSince}::timestamptz)::int AS count_30d,
                 count(*) FILTER (WHERE pr.created_at >= ${longSince}::timestamptz)::int AS count_90d
          FROM player_reports pr
          JOIN players p ON p.id = pr.target_player_id
          WHERE pr.target_player_id IS NOT NULL
            AND pr.created_at >= ${longSince}::timestamptz
            AND (${serverId}::uuid IS NULL OR pr.server_id = ${serverId}::uuid)
          GROUP BY pr.target_player_id, p.canonical_name
          HAVING count(*) FILTER (WHERE pr.created_at >= ${longSince}::timestamptz) > 0
          ORDER BY count_90d DESC, count_30d DESC, name ASC
          LIMIT ${limit}
        `),
          // Ranked by the reports filed in the requested server/window, like
          // every other section; confirmed/accuracy/trusted/spam_flagged are the
          // reporter's overall reputation from reporter_stats.
          app.db.execute<TopReporterRow>(sql`
          SELECT pr.reporter_player_id AS player_id,
                 p.canonical_name AS name,
                 count(*)::int AS total,
                 count(*) FILTER (WHERE pr.status = 'resolved')::int AS resolved,
                 count(*) FILTER (WHERE pr.status = 'rejected')::int AS rejected,
                 COALESCE(rs.confirmed_reports, 0) AS confirmed,
                 COALESCE(rs.accuracy, 0) AS accuracy,
                 COALESCE(rs.trusted, false) AS trusted,
                 (rs.spam_flagged_at IS NOT NULL) AS spam_flagged
          FROM player_reports pr
          JOIN players p ON p.id = pr.reporter_player_id
          LEFT JOIN reporter_stats rs ON rs.player_id = pr.reporter_player_id
          WHERE ${reportFilter} AND pr.reporter_player_id IS NOT NULL
          GROUP BY pr.reporter_player_id, p.canonical_name, rs.confirmed_reports, rs.accuracy,
                   rs.trusted, rs.spam_flagged_at
          ORDER BY total DESC, name ASC
          LIMIT ${limit}
        `),
        ]);
      const summaryRow = summaryRows[0];

      const payload: ReportAnalyticsPayload = {
        server_id: serverId,
        from: fromIso,
        to: toIso,
        summary: {
          total: Number(summaryRow?.total ?? 0),
          by_status: {
            pending: Number(summaryRow?.pending ?? 0),
            in_review: Number(summaryRow?.in_review ?? 0),
            resolved: Number(summaryRow?.resolved ?? 0),
            rejected: Number(summaryRow?.rejected ?? 0),
          },
          avg_resolution_seconds:
            summaryRow?.avg_resolution_seconds != null
              ? Number(summaryRow.avg_resolution_seconds)
              : null,
          median_resolution_seconds:
            summaryRow?.median_resolution_seconds != null
              ? Number(summaryRow.median_resolution_seconds)
              : null,
        },
        trend: trendRows.map((row) => ({ day: row.day, count: Number(row.count) })),
        by_server: byServerRows.map((row) => ({
          server_id: row.server_id,
          server_name: row.server_name,
          total: Number(row.total),
          resolved: Number(row.resolved),
          rejected: Number(row.rejected),
        })),
        by_handler: byHandlerRows.map((row) => ({
          player_id: row.player_id,
          name: row.name,
          handled: Number(row.handled),
          resolved: Number(row.resolved),
          rejected: Number(row.rejected),
          avg_resolution_seconds:
            row.avg_resolution_seconds != null ? Number(row.avg_resolution_seconds) : null,
        })),
        top_targets: topTargetRows.map((row) => ({
          player_id: row.player_id,
          name: row.name,
          count_30d: Number(row.count_30d),
          count_90d: Number(row.count_90d),
        })),
        top_reporters: topReporterRows.map((row) => ({
          player_id: row.player_id,
          name: row.name,
          total: Number(row.total),
          resolved: Number(row.resolved),
          rejected: Number(row.rejected),
          confirmed: Number(row.confirmed),
          accuracy: Number(row.accuracy),
          trusted: Boolean(row.trusted),
          spam_flagged: Boolean(row.spam_flagged),
        })),
      };

      if (req.query.format === 'csv') {
        void reply.header('content-type', 'text/csv; charset=utf-8');
        void reply.header('content-disposition', 'attachment; filename="report-analytics.csv"');
        return toCsv(payload);
      }

      return payload;
    },
  );
};

export default reportAnalyticsRoutes;
