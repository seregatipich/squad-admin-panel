import { moderationActions, playerReports, players } from '@squad/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import { sendRconCommandViaWorker } from '../lib/rcon-worker-command.js';
import { notifyReporter, type ReporterNotifyTemplate } from '../lib/report-notify.js';
import { parseStoredRoster } from '../lib/roster.js';
import type { ReportLiveView } from '../plugins/live-bus.js';

const REASON_MAX = 300;
const BAN_LENGTH_PATTERN = /^\d+[smhdwMy]?$/;
const RESOLUTION_NOTE_MAX = 2000;

const idParam = z.object({ id: z.string().uuid() });

const actionBody = z.object({
  action_type: z.enum(['warn', 'kick', 'ban']),
  reason: z.string().trim().min(1).max(REASON_MAX),
  ban_length: z.string().trim().regex(BAN_LENGTH_PATTERN, 'invalid ban_length').optional(),
});

const notifyBody = z.object({
  template: z.enum(['in_review', 'resolved']),
});

const bulkResolveBody = z.object({
  target_player_id: z.string().uuid(),
  status: z.enum(['resolved', 'rejected']),
  resolution_note: z.string().trim().min(1).max(RESOLUTION_NOTE_MAX),
});

interface ModerationActionApiRow {
  id: string;
  action_type: string;
  reason: string | null;
  context: unknown;
  report_id: string | null;
  created_at: Date | string;
  reverted_at: Date | string | null;
  server_id: string | null;
  server_name: string | null;
  author_player_id: string | null;
  author_name: string | null;
  author_system_label: string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function serializeActionRow(row: ModerationActionApiRow) {
  return {
    id: row.id,
    action_type: row.action_type,
    reason: row.reason,
    context: row.context ?? {},
    report_id: row.report_id,
    created_at: toIso(row.created_at),
    reverted_at: toIso(row.reverted_at),
    server: row.server_id ? { id: row.server_id, name: row.server_name } : null,
    author: row.author_player_id
      ? { kind: 'player' as const, id: row.author_player_id, name: row.author_name }
      : { kind: 'system' as const, label: row.author_system_label },
  };
}

const ACTION_ROW_SELECT = sql`
  ma.id,
  ma.action_type,
  ma.reason,
  ma.context,
  ma.report_id,
  ma.created_at,
  ma.reverted_at,
  ma.server_id,
  s.display_name AS server_name,
  ma.author_player_id,
  ap.canonical_name AS author_name,
  ma.author_system_label
`;

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

function handlerGuard(
  req: FastifyRequest,
  reply: FastifyReply,
): { error: string; required?: string } | null {
  const denied = panelGuard(req, reply);
  if (denied) return denied;
  if (!req.user?.permissions.canHandleReports) {
    reply.code(403);
    return { error: 'forbidden', required: 'can_handle_reports' };
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
  reporterPlayerId: string | null;
  targetPlayerId: string | null;
  status: string;
}

/**
 * Report-scoped moderation actions (REPORT-3, #113). Lets a moderator warn,
 * kick, or ban a report's target directly from the report card — the action
 * is enqueued through the same worker-rcon command pipeline as MOD-2 would
 * use and recorded in `moderation_actions` with {@link reportId} set, so the
 * enforcement shows up both in the player's moderation history and on the
 * report card itself. Also exposes reporter notification and a bulk-resolve
 * shortcut for closing every pending report against one target at once.
 *
 * MOD-2 (#59, generic player-card enforcement) is not built yet; this route
 * implements the RCON-send + ledger-insert path scoped to reports. When
 * MOD-2 lands, it should reuse this insert logic rather than duplicate it.
 */
const reportActionsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadReport(id: string): Promise<ReportRow | null> {
    const rows = await app.db
      .select({
        id: playerReports.id,
        serverId: playerReports.serverId,
        reporterPlayerId: playerReports.reporterPlayerId,
        targetPlayerId: playerReports.targetPlayerId,
        status: playerReports.status,
      })
      .from(playerReports)
      .where(eq(playerReports.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async function resolveIdentity(
    playerId: string,
  ): Promise<{ eosId: string | null; steamId64: string | null } | null> {
    const rows = await app.db
      .select({ eosId: players.eosId, steamId64: players.steamId64 })
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      eosId: row.eosId,
      steamId64: row.steamId64 != null ? row.steamId64.toString() : null,
    };
  }

  async function isOnline(
    serverId: string,
    identity: { eosId: string | null; steamId64: string | null },
  ): Promise<boolean> {
    const stored = parseStoredRoster(await app.redis.get(`rcon:roster:${serverId}`));
    return (stored?.players ?? []).some(
      (entry) =>
        (identity.eosId && entry.eos_id === identity.eosId) ||
        (identity.steamId64 && entry.steam_id64 === identity.steamId64),
    );
  }

  /**
   * Warns, kicks, or bans a report's target and links the resulting
   * moderation_actions row back to the report. Warn/kick require the target
   * to currently be online (checked via the live roster); ban does not,
   * since Squad's AdminBan accepts an offline SteamID64.
   */
  fast.post(
    '/api/v1/reports/:id/actions',
    { schema: { params: idParam, body: actionBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = handlerGuard(req, reply);
      if (denied) return denied;

      const report = await loadReport(req.params.id);
      if (!report) {
        reply.code(404);
        return { error: 'report_not_found' };
      }
      if (!report.targetPlayerId) {
        reply.code(400);
        return { error: 'report_target_unresolved' };
      }

      const identity = await resolveIdentity(report.targetPlayerId);
      const target = identity?.eosId ?? identity?.steamId64 ?? null;
      if (!target) {
        reply.code(400);
        return { error: 'target_identity_missing' };
      }

      const { action_type: actionType, reason } = req.body;
      if (actionType !== 'ban') {
        const online = identity && (await isOnline(report.serverId, identity));
        if (!online) {
          reply.code(409);
          return { error: 'target_offline' };
        }
      }

      const banLength = req.body.ban_length ?? '0';
      const command =
        actionType === 'warn' ? 'AdminWarn' : actionType === 'kick' ? 'AdminKick' : 'AdminBan';
      const args = actionType === 'ban' ? [target, banLength, reason] : [target, reason];

      // biome-ignore lint/style/noNonNullAssertion: handlerGuard rejects unauthenticated requests
      const actorPlayerId = req.user!.playerId;
      const viaWorker = await sendRconCommandViaWorker(app.redis, {
        serverId: report.serverId,
        command,
        args,
        actorPlayerId,
      });

      if (!viaWorker.attempted || !viaWorker.ok) {
        reply.code(502);
        return {
          error: 'action_failed',
          reason: viaWorker.attempted ? viaWorker.reason : viaWorker.reason,
          detail: viaWorker.attempted ? viaWorker.detail : undefined,
        };
      }

      const context: Record<string, unknown> = { report_id: report.id };
      if (actionType === 'ban') context.ban_length = banLength;

      const [inserted] = await app.db
        .insert(moderationActions)
        .values({
          playerId: report.targetPlayerId,
          serverId: report.serverId,
          actionType,
          authorPlayerId: actorPlayerId,
          reason,
          context,
          reportId: report.id,
        })
        .returning({ id: moderationActions.id });

      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'report.action',
        targetType: 'report',
        targetId: report.id,
        after: { action_type: actionType, reason, target_player_id: report.targetPlayerId },
        context: {
          requestId: req.id,
          method: req.method,
          url: req.url,
          moderation_action_id: inserted?.id,
        },
        statusCode: reply.statusCode,
      });

      const rows = (await app.db.execute(sql`
        SELECT ${ACTION_ROW_SELECT}
        FROM moderation_actions ma
        LEFT JOIN players ap ON ap.id = ma.author_player_id
        LEFT JOIN servers s ON s.id = ma.server_id
        WHERE ma.id = ${inserted?.id}
      `)) as unknown as ModerationActionApiRow[];
      const row = rows[0];
      return row ? serializeActionRow(row) : { ok: true };
    },
  );

  /** Lists the moderation actions linked to a report, for the report card. */
  fast.get(
    '/api/v1/reports/:id/actions',
    { schema: { params: idParam }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const report = await loadReport(req.params.id);
      if (!report) {
        reply.code(404);
        return { error: 'report_not_found' };
      }

      const rows = (await app.db.execute(sql`
        SELECT ${ACTION_ROW_SELECT}
        FROM moderation_actions ma
        LEFT JOIN players ap ON ap.id = ma.author_player_id
        LEFT JOIN servers s ON s.id = ma.server_id
        WHERE ma.report_id = ${report.id}
        ORDER BY ma.created_at DESC, ma.id DESC
      `)) as unknown as ModerationActionApiRow[];

      return { actions: rows.map(serializeActionRow) };
    },
  );

  /** Sends the reporter an AdminWarn status template, if they're online. */
  fast.post(
    '/api/v1/reports/:id/notify-reporter',
    { schema: { params: idParam, body: notifyBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = handlerGuard(req, reply);
      if (denied) return denied;

      const report = await loadReport(req.params.id);
      if (!report) {
        reply.code(404);
        return { error: 'report_not_found' };
      }
      if (!report.reporterPlayerId) {
        reply.code(400);
        return { error: 'report_reporter_unresolved' };
      }

      const outcome = await notifyReporter(app.db, app.redis, {
        serverId: report.serverId,
        reporterPlayerId: report.reporterPlayerId,
        template: req.body.template as ReporterNotifyTemplate,
        // biome-ignore lint/style/noNonNullAssertion: handlerGuard rejects unauthenticated requests
        actorPlayerId: req.user!.playerId,
      });

      if (!outcome.notified) {
        reply.code(409);
        return {
          error: outcome.reason === 'reporter_offline' ? 'reporter_offline' : outcome.reason,
        };
      }

      await writeAuditEntry(app.db, {
        actor: auditActor(req),
        actorIp: req.ip ?? null,
        actionType: 'report.notify_reporter',
        targetType: 'report',
        targetId: report.id,
        after: { template: req.body.template },
        context: { requestId: req.id, method: req.method, url: req.url },
        statusCode: reply.statusCode,
      });

      return { ok: true };
    },
  );

  /**
   * Resolves/rejects every pending or in-review report against one target in
   * a single action, writing one audit entry per report (sharing a
   * `bulk_group` id in context) and best-effort notifying each distinct
   * online reporter once.
   */
  fast.post(
    '/api/v1/reports/bulk-resolve',
    { schema: { body: bulkResolveBody }, config: { audit: false } },
    async (req, reply) => {
      const denied = handlerGuard(req, reply);
      if (denied) return denied;

      const {
        target_player_id: targetPlayerId,
        status,
        resolution_note: resolutionNote,
      } = req.body;
      const targets = await app.db
        .select({
          id: playerReports.id,
          serverId: playerReports.serverId,
          reporterPlayerId: playerReports.reporterPlayerId,
        })
        .from(playerReports)
        .where(
          and(
            eq(playerReports.targetPlayerId, targetPlayerId),
            inArray(playerReports.status, ['pending', 'in_review']),
          ),
        )
        .orderBy(desc(playerReports.createdAt));

      if (targets.length === 0) {
        reply.code(404);
        return { error: 'no_pending_reports' };
      }

      const ids = targets.map((t) => t.id);
      // biome-ignore lint/style/noNonNullAssertion: handlerGuard rejects unauthenticated requests
      const handlerPlayerId = req.user!.playerId;
      const resolvedAt = new Date();
      await app.db
        .update(playerReports)
        .set({ status, handlerPlayerId, resolutionNote, resolvedAt })
        .where(inArray(playerReports.id, ids));

      const bulkGroup = uuidv7();
      const notifiedReporters = new Set<string>();
      const updated = await app.db
        .select({
          id: playerReports.id,
          serverId: playerReports.serverId,
          reporterPlayerId: playerReports.reporterPlayerId,
          targetPlayerId: playerReports.targetPlayerId,
          targetRaw: playerReports.targetRaw,
          body: playerReports.body,
          source: playerReports.source,
          status: playerReports.status,
          handlerPlayerId: playerReports.handlerPlayerId,
          resolutionNote: playerReports.resolutionNote,
          createdAt: playerReports.createdAt,
          claimedAt: playerReports.claimedAt,
          resolvedAt: playerReports.resolvedAt,
        })
        .from(playerReports)
        .where(inArray(playerReports.id, ids));

      for (const report of updated) {
        await writeAuditEntry(app.db, {
          actor: auditActor(req),
          actorIp: req.ip ?? null,
          actionType: 'report.update',
          targetType: 'report',
          targetId: report.id,
          after: { status, resolution_note: resolutionNote },
          context: {
            requestId: req.id,
            method: req.method,
            url: req.url,
            bulk_group: bulkGroup,
            target_player_id: targetPlayerId,
          },
          statusCode: reply.statusCode,
        });

        const liveView: ReportLiveView = {
          id: report.id,
          server_id: report.serverId,
          reporter_player_id: report.reporterPlayerId,
          target_player_id: report.targetPlayerId,
          target_raw: report.targetRaw,
          body: report.body,
          source: report.source as ReportLiveView['source'],
          status: report.status as ReportLiveView['status'],
          handler_player_id: report.handlerPlayerId,
          resolution_note: report.resolutionNote,
          created_at: report.createdAt.toISOString(),
          claimed_at: report.claimedAt ? report.claimedAt.toISOString() : null,
          resolved_at: report.resolvedAt ? report.resolvedAt.toISOString() : null,
        };
        app.liveBus.publish({
          type: 'report.updated',
          ts: new Date().toISOString(),
          data: { report: liveView },
        });

        if (report.reporterPlayerId && !notifiedReporters.has(report.reporterPlayerId)) {
          notifiedReporters.add(report.reporterPlayerId);
          await notifyReporter(app.db, app.redis, {
            serverId: report.serverId,
            reporterPlayerId: report.reporterPlayerId,
            template: 'resolved',
            actorPlayerId: handlerPlayerId,
          }).catch(() => undefined);
        }
      }

      return { ok: true, resolved_ids: ids };
    },
  );
};

export default reportActionsRoutes;
