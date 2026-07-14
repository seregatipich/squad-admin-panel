import { playerReports, players, servers } from '@squad/db/schema';
import { and, desc, eq, gte, ilike, lte, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import { notifyReporter } from '../lib/report-notify.js';
import type { ReportLiveView } from '../plugins/live-bus.js';

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const BODY_MAX = 200;
const RESOLUTION_NOTE_MAX = 2000;

const statusEnum = z.enum(['pending', 'in_review', 'resolved', 'rejected']);

const listQuery = z.object({
  status: statusEnum.optional(),
  server_id: z.string().uuid().optional(),
  target_player_id: z.string().uuid().optional(),
  reporter_player_id: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(BODY_MAX).optional(),
  created_from: z.coerce.date().optional(),
  created_to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

const idParam = z.object({ id: z.string().uuid() });

const patchBody = z
  .object({
    status: statusEnum.optional(),
    resolution_note: z.string().trim().max(RESOLUTION_NOTE_MAX).nullable().optional(),
  })
  .refine((body) => body.status !== undefined || body.resolution_note !== undefined, {
    message: 'empty_update',
  });

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
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

function auditActor(req: FastifyRequest): AuditActor {
  return {
    kind: 'steam',
    // biome-ignore lint/style/noNonNullAssertion: callers guard req.user first
    playerId: req.user!.playerId,
    tokenId: req.apiTokenId ?? null,
  };
}

interface ReportRow {
  id: string;
  serverId: string;
  serverName: string | null;
  serverSlug: string | null;
  reporterPlayerId: string | null;
  reporterName: string | null;
  targetPlayerId: string | null;
  targetName: string | null;
  targetRaw: string | null;
  body: string;
  source: string;
  status: string;
  handlerPlayerId: string | null;
  handlerName: string | null;
  resolutionNote: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  resolvedAt: Date | null;
}

function serializeReport(row: ReportRow) {
  return {
    id: row.id,
    server_id: row.serverId,
    server_name: row.serverName,
    server_slug: row.serverSlug,
    reporter_player_id: row.reporterPlayerId,
    reporter_name: row.reporterName,
    target_player_id: row.targetPlayerId,
    target_name: row.targetName,
    target_raw: row.targetRaw,
    body: row.body,
    source: row.source,
    status: row.status,
    handler_player_id: row.handlerPlayerId,
    handler_name: row.handlerName,
    resolution_note: row.resolutionNote,
    created_at: row.createdAt.toISOString(),
    claimed_at: row.claimedAt ? row.claimedAt.toISOString() : null,
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

function toLiveView(row: ReportRow): ReportLiveView {
  return {
    id: row.id,
    server_id: row.serverId,
    reporter_player_id: row.reporterPlayerId,
    target_player_id: row.targetPlayerId,
    target_raw: row.targetRaw,
    body: row.body,
    source: row.source as ReportLiveView['source'],
    status: row.status as ReportLiveView['status'],
    handler_player_id: row.handlerPlayerId,
    resolution_note: row.resolutionNote,
    created_at: row.createdAt.toISOString(),
    claimed_at: row.claimedAt ? row.claimedAt.toISOString() : null,
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/**
 * Report moderation queue (REPORT-2, #112). Exposes the `player_reports`
 * data layer written by REPORT-1 for panel review: a filterable/paginated
 * list, a detail view, and a status/handler-note PATCH gated by
 * `can_handle_reports`.
 */
const reportsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const reporter = alias(players, 'reporter');
  const target = alias(players, 'target');
  const handler = alias(players, 'handler');

  function baseSelection() {
    return app.db
      .select({
        id: playerReports.id,
        serverId: playerReports.serverId,
        serverName: servers.displayName,
        serverSlug: servers.slug,
        reporterPlayerId: playerReports.reporterPlayerId,
        reporterName: reporter.canonicalName,
        targetPlayerId: playerReports.targetPlayerId,
        targetName: target.canonicalName,
        targetRaw: playerReports.targetRaw,
        body: playerReports.body,
        source: playerReports.source,
        status: playerReports.status,
        handlerPlayerId: playerReports.handlerPlayerId,
        handlerName: handler.canonicalName,
        resolutionNote: playerReports.resolutionNote,
        createdAt: playerReports.createdAt,
        claimedAt: playerReports.claimedAt,
        resolvedAt: playerReports.resolvedAt,
      })
      .from(playerReports)
      .leftJoin(servers, eq(servers.id, playerReports.serverId))
      .leftJoin(reporter, eq(reporter.id, playerReports.reporterPlayerId))
      .leftJoin(target, eq(target.id, playerReports.targetPlayerId))
      .leftJoin(handler, eq(handler.id, playerReports.handlerPlayerId));
  }

  function buildFilters(query: z.infer<typeof listQuery>): SQL[] {
    const clauses: SQL[] = [];
    if (query.status) clauses.push(eq(playerReports.status, query.status));
    if (query.server_id) clauses.push(eq(playerReports.serverId, query.server_id));
    if (query.target_player_id) {
      clauses.push(eq(playerReports.targetPlayerId, query.target_player_id));
    }
    if (query.reporter_player_id) {
      clauses.push(eq(playerReports.reporterPlayerId, query.reporter_player_id));
    }
    if (query.q) clauses.push(ilike(playerReports.body, `%${escapeLike(query.q)}%`));
    if (query.created_from) clauses.push(gte(playerReports.createdAt, query.created_from));
    if (query.created_to) clauses.push(lte(playerReports.createdAt, query.created_to));
    return clauses;
  }

  async function loadReport(id: string): Promise<ReportRow | null> {
    const rows = await baseSelection().where(eq(playerReports.id, id)).limit(1);
    return rows[0] ?? null;
  }

  fast.get(
    '/api/v1/reports',
    { schema: { querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { page, page_size: pageSize } = req.query;
      const clauses = buildFilters(req.query);
      const whereClause = clauses.length > 0 ? and(...clauses) : undefined;

      const countRows = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(playerReports)
        .where(whereClause);
      const total = countRows[0]?.total ?? 0;

      const rows = await baseSelection()
        .where(whereClause)
        .orderBy(desc(playerReports.createdAt), desc(playerReports.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        items: rows.map(serializeReport),
        total,
        page,
        page_size: pageSize,
      };
    },
  );

  fast.get(
    '/api/v1/reports/:id',
    { schema: { params: idParam }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const report = await loadReport(req.params.id);
      if (!report) {
        reply.code(404);
        return { error: 'report_not_found' };
      }
      return serializeReport(report);
    },
  );

  fast.patch(
    '/api/v1/reports/:id',
    { schema: { params: idParam, body: patchBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;
      if (!req.user?.permissions.canHandleReports) {
        reply.code(403);
        return { error: 'forbidden', required: 'can_handle_reports' };
      }

      const existing = await loadReport(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'report_not_found' };
      }
      const before = serializeReport(existing);

      const updates: Partial<typeof playerReports.$inferInsert> = {};
      if (req.body.status !== undefined && req.body.status !== existing.status) {
        updates.status = req.body.status;
        updates.handlerPlayerId = req.user.playerId;
        if (req.body.status === 'in_review' && !existing.claimedAt) {
          updates.claimedAt = new Date();
        }
        if (req.body.status === 'resolved' || req.body.status === 'rejected') {
          updates.resolvedAt = new Date();
        }
      }
      if (req.body.resolution_note !== undefined) {
        updates.resolutionNote = req.body.resolution_note;
        updates.handlerPlayerId = req.user.playerId;
      }

      if (Object.keys(updates).length > 0) {
        await app.db.update(playerReports).set(updates).where(eq(playerReports.id, existing.id));
      }

      const updated = await loadReport(existing.id);
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }
      const after = serializeReport(updated);

      // Best-effort reporter notification on claim/resolve/reject (REPORT-3,
      // #113 P2). Never blocks or fails the PATCH — notify errors are only
      // recorded in the audit context.
      let notified = false;
      const statusChanged = updates.status !== undefined;
      const notifyTemplate: 'in_review' | 'resolved' | null =
        updates.status === 'in_review'
          ? 'in_review'
          : updates.status === 'resolved' || updates.status === 'rejected'
            ? 'resolved'
            : null;
      if (statusChanged && notifyTemplate && updated.reporterPlayerId) {
        try {
          const outcome = await notifyReporter(app.db, app.redis, {
            serverId: updated.serverId,
            reporterPlayerId: updated.reporterPlayerId,
            template: notifyTemplate,
            actorPlayerId: req.user.playerId,
          });
          notified = outcome.notified;
        } catch {
          notified = false;
        }
      }

      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'report.update',
        targetType: 'report',
        targetId: existing.id,
        before,
        after,
        context: { requestId: req.id, method: req.method, url: req.url, notified },
        statusCode: reply.statusCode,
      });
      app.liveBus.publish({
        type: 'report.updated',
        ts: new Date().toISOString(),
        data: { report: toLiveView(updated) },
      });
      return after;
    },
  );
};

export default reportsRoutes;
