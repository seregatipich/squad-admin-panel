import { playerReports, players } from '@squad/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { raiseAltBanAlert } from '../lib/alt-ban-alert.js';
import { type AuditActor, writeAuditEntry } from '../lib/audit.js';
import { loadBanAltWarning } from '../lib/ban-alt-warning.js';
import { enforceModerationAction, type PlayerIdentity } from '../lib/moderation-enforce.js';
import { panelGuard } from '../lib/panel-guard.js';
import { notifyReporter } from '../lib/report-notify.js';
import { recomputeReporterStats } from '../lib/reporter-stats.js';
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
  also_player_ids: z.array(z.string().uuid()).max(20).default([]),
});

const notifyBody = z.object({
  template: z.enum(['in_review', 'resolved']),
});

const bulkResolveBody = z.object({
  target_player_id: z.string().uuid(),
  status: z.enum(['resolved', 'rejected']),
  resolution_note: z.string().trim().min(1).max(RESOLUTION_NOTE_MAX),
});

interface ModerationActionApiRow extends Record<string, unknown> {
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
 * kick, or ban a report's target directly from the report card. Each target
 * is enforced through the shared MOD-2 pipeline
 * ({@link enforceModerationAction}, `source: 'report'`), which records the
 * `moderation_actions` row with `report_id` set — so the enforcement shows up
 * both in the player's moderation history and on the report card — plus the
 * same `context` (`expires_at`, `rcon_request_id`, `target`) as every other
 * moderation surface. Also exposes reporter notification and a bulk-resolve
 * shortcut for closing every pending report against one target at once.
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

  async function resolveIdentity(playerId: string): Promise<PlayerIdentity | null> {
    const rows = await app.db
      .select({
        eosId: players.eosId,
        steamId64: players.steamId64,
        name: players.canonicalName,
      })
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      eosId: row.eosId,
      steamId64: row.steamId64 != null ? row.steamId64.toString() : null,
      name: row.name,
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
   * moderation_actions row back to the report. Requires `can_handle_reports`
   * plus the live-Squad `ban` (ban) or `kick` (warn/kick) permission. Warn/kick
   * require the target to currently be online (checked via the live roster);
   * ban does not, since Squad's AdminBan accepts an offline SteamID64.
   */
  fast.post(
    '/api/v1/reports/:id/actions',
    { schema: { params: idParam, body: actionBody }, config: { audit: 'manual' } },
    async (req, reply) => {
      const denied = handlerGuard(req, reply);
      if (denied) return denied;
      // MOD-2 — the same live-Squad permission `moderationWriteGuard` in
      // `moderation-actions.ts` requires: `ban` for a ban (and its alts),
      // `kick` for a warn or kick. `can_handle_reports` alone never grants it.
      const requiredSquad = req.body.action_type === 'ban' ? 'ban' : 'kick';
      if (!req.user?.permissions.squadPermissions.has(requiredSquad)) {
        reply.code(403);
        return { error: 'forbidden', required: requiredSquad };
      }

      const report = await loadReport(req.params.id);
      if (!report) {
        reply.code(404);
        return { error: 'report_not_found' };
      }
      if (!report.targetPlayerId) {
        reply.code(400);
        return { error: 'report_target_unresolved' };
      }

      const { action_type: actionType, reason, also_player_ids: alsoPlayerIds } = req.body;
      let warning = null;
      if (actionType === 'ban') {
        try {
          warning = await loadBanAltWarning(app, {
            playerId: report.targetPlayerId,
            canViewIps: req.user?.permissions.permissions.has('player:view_ips') ?? false,
          });
        } catch (error) {
          req.log.warn({ error }, 'ALT-7 warning lookup failed; continuing with the ban');
        }
      }

      if (alsoPlayerIds.length > 0 && !warning?.can_view_ips) {
        reply.code(403);
        return { error: 'alt_details_forbidden' };
      }
      const confirmedAltIds = new Set(warning?.confirmed.map((alt) => alt.player_id) ?? []);
      if (alsoPlayerIds.some((id) => !confirmedAltIds.has(id))) {
        reply.code(400);
        return { error: 'invalid_alt_selection' };
      }

      const targetPlayerIds = [report.targetPlayerId, ...new Set(alsoPlayerIds)];
      const targetIdentities = await Promise.all(targetPlayerIds.map(resolveIdentity));
      const targetEntries = targetPlayerIds.map((playerId, index) => ({
        playerId,
        identity: targetIdentities[index],
      }));
      const primaryEntry = targetEntries[0];
      const primaryIdentity = primaryEntry?.identity;
      const target = primaryIdentity?.eosId ?? primaryIdentity?.steamId64 ?? null;
      if (!primaryEntry || !primaryIdentity || !target) {
        reply.code(400);
        return { error: 'target_identity_missing' };
      }

      if (actionType !== 'ban') {
        const online = primaryIdentity && (await isOnline(report.serverId, primaryIdentity));
        if (!online) {
          reply.code(409);
          return { error: 'target_offline' };
        }
      }

      // Every alt must resolve to an RCON target before anything is sent, so
      // a missing identity can never strand a half-applied multi-ban.
      for (const entry of targetEntries) {
        if (!entry.identity?.eosId && !entry.identity?.steamId64) {
          reply.code(400);
          return { error: 'alt_identity_missing', player_id: entry.playerId };
        }
      }

      const banLength = req.body.ban_length ?? '0';
      // biome-ignore lint/style/noNonNullAssertion: handlerGuard rejects unauthenticated requests
      const actor = req.user!;
      const actorPlayerId = actor.playerId;

      // Not transactional, like MOD-4 bulk moderation (moderation-bulk.ts): an
      // applied RCON command has no inverse, so each target is persisted
      // (ledger + EVT-1 inside enforceModerationAction, then its audit row)
      // as soon as its command is confirmed. A later failure stops the loop
      // and reports what was already applied instead of leaving it untraced.
      const applied: Array<{ player_id: string; moderation_action_id: string }> = [];
      let primaryActionId: string | null = null;
      let failure: Record<string, unknown> | null = null;
      for (const entry of targetEntries) {
        // biome-ignore lint/style/noNonNullAssertion: every identity was checked above
        const identity = entry.identity!;
        const isPrimary = entry.playerId === primaryEntry.playerId;
        const result = await enforceModerationAction(app, {
          serverId: report.serverId,
          playerId: entry.playerId,
          identity,
          actionType,
          reason,
          banLength,
          actorPlayerId,
          actorName: actor.canonicalName,
          reportId: report.id,
          source: 'report',
          extraContext: isPrimary
            ? {
                report_id: report.id,
                ...(alsoPlayerIds.length > 0 ? { also_player_ids: alsoPlayerIds } : {}),
              }
            : { report_id: report.id, related_action_id: primaryActionId },
        });

        const status = result.ok ? 'applied' : 'failed';
        if (!isPrimary || !result.ok) {
          // Per-target trail for alts, and for any target whose command was
          // sent but not confirmed: a timed-out command may still land.
          await writeAuditEntry(app.db, {
            actor: auditActor(req),
            actorIp: req.ip ?? null,
            actionType: 'report.action',
            targetType: 'player',
            targetId: entry.playerId,
            after: {
              action_type: actionType,
              reason,
              target_player_id: entry.playerId,
              status,
              moderation_action_id: result.ok ? result.actionId : null,
              related_action_id: isPrimary ? null : primaryActionId,
            },
            context: {
              requestId: req.id,
              method: req.method,
              url: req.url,
              report_id: report.id,
              related_action_id: isPrimary ? null : primaryActionId,
            },
            statusCode: result.ok ? 200 : 502,
          });
        }
        if (isPrimary && result.ok) {
          await writeAuditEntry(app.db, {
            actor: auditActor(req),
            actorIp: req.ip ?? null,
            actionType: 'report.action',
            targetType: 'report',
            targetId: report.id,
            after: {
              action_type: actionType,
              reason,
              target_player_id: report.targetPlayerId,
              also_player_ids: alsoPlayerIds,
            },
            context: {
              requestId: req.id,
              method: req.method,
              url: req.url,
              moderation_action_id: result.actionId,
            },
            statusCode: 200,
          });
        }

        if (!result.ok) {
          const outcome = result.outcome;
          failure = {
            error: 'action_failed',
            reason: !outcome.attempted || !outcome.ok ? outcome.reason : undefined,
            detail: outcome.attempted && !outcome.ok ? outcome.detail : undefined,
            player_id: entry.playerId,
            applied,
          };
          break;
        }
        if (isPrimary) primaryActionId = result.actionId;
        applied.push({ player_id: entry.playerId, moderation_action_id: result.actionId });
      }

      // Linking a moderation action to the report changes its reporter's
      // "confirmed" count (REPORT-5, #115) — recompute their trust metrics.
      // Best-effort: a stats failure must never fail the enforcement action.
      if (applied.length > 0 && report.reporterPlayerId) {
        await recomputeReporterStats(app.db, app.redis, report.reporterPlayerId).catch(
          () => undefined,
        );
      }
      if (failure) {
        reply.code(502);
        return failure;
      }
      // biome-ignore lint/style/noNonNullAssertion: no failure means the primary target was applied
      const insertedId = primaryActionId!;

      if (
        actionType === 'ban' &&
        warning &&
        (warning.confirmed_count > 0 || warning.candidate_count > 0)
      ) {
        await raiseAltBanAlert(app.db, app.redis, {
          target_player_id: report.targetPlayerId,
          confirmed_alt_ids: warning.confirmed.map((alt) => alt.player_id),
          candidate_ids: warning.candidates.map((candidate) => candidate.player_id),
          trigger: 'admin_ban',
        }).catch((error) => {
          req.log.warn({ error }, 'AUTO-3 alt ban alert failed');
        });
      }

      const rows = await app.db.execute<ModerationActionApiRow>(sql`
        SELECT ${ACTION_ROW_SELECT}
        FROM moderation_actions ma
        LEFT JOIN players ap ON ap.id = ma.author_player_id
        LEFT JOIN servers s ON s.id = ma.server_id
        WHERE ma.id = ${insertedId}
      `);
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

      const rows = await app.db.execute<ModerationActionApiRow>(sql`
        SELECT ${ACTION_ROW_SELECT}
        FROM moderation_actions ma
        LEFT JOIN players ap ON ap.id = ma.author_player_id
        LEFT JOIN servers s ON s.id = ma.server_id
        WHERE ma.report_id = ${report.id}
        ORDER BY ma.created_at DESC, ma.id DESC
      `);

      return { actions: rows.map(serializeActionRow) };
    },
  );

  /** Sends the reporter an AdminWarn status template, if they're online. */
  fast.post(
    '/api/v1/reports/:id/notify-reporter',
    { schema: { params: idParam, body: notifyBody }, config: { audit: 'manual' } },
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
        template: req.body.template,
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
   * `bulk_group` id in context, with the replaced state as `before`) in the
   * same transaction as the update, then best-effort notifying each distinct
   * online reporter once. Reports closed concurrently by another handler are
   * left untouched and omitted from `resolved_ids`.
   */
  fast.post(
    '/api/v1/reports/bulk-resolve',
    { schema: { body: bulkResolveBody }, config: { audit: 'manual' } },
    async (req, reply) => {
      const denied = handlerGuard(req, reply);
      if (denied) return denied;

      const {
        target_player_id: targetPlayerId,
        status,
        resolution_note: resolutionNote,
      } = req.body;
      // biome-ignore lint/style/noNonNullAssertion: handlerGuard rejects unauthenticated requests
      const handlerPlayerId = req.user!.playerId;
      const resolvedAt = new Date();
      const bulkGroup = uuidv7();

      // Lock, update and audit in one transaction. `FOR UPDATE` re-checks the
      // status filter against the latest committed row, so a report another
      // handler closed after this request started is skipped rather than
      // overwritten, and each audit row carries the state it replaced.
      const updated = await app.db.transaction(async (tx) => {
        const open = await tx
          .select({
            id: playerReports.id,
            status: playerReports.status,
            handlerPlayerId: playerReports.handlerPlayerId,
            resolutionNote: playerReports.resolutionNote,
          })
          .from(playerReports)
          .where(
            and(
              eq(playerReports.targetPlayerId, targetPlayerId),
              inArray(playerReports.status, ['pending', 'in_review']),
            ),
          )
          .orderBy(desc(playerReports.createdAt))
          .for('update');
        if (open.length === 0) return [];

        const rows = await tx
          .update(playerReports)
          .set({ status, handlerPlayerId, resolutionNote, resolvedAt })
          .where(
            inArray(
              playerReports.id,
              open.map((report) => report.id),
            ),
          )
          .returning({
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
          });

        const beforeById = new Map(open.map((report) => [report.id, report]));
        for (const report of rows) {
          const before = beforeById.get(report.id);
          await writeAuditEntry(tx, {
            actor: auditActor(req),
            actorIp: req.ip ?? null,
            actionType: 'report.update',
            targetType: 'report',
            targetId: report.id,
            before: {
              status: before?.status ?? null,
              handler_player_id: before?.handlerPlayerId ?? null,
              resolution_note: before?.resolutionNote ?? null,
            },
            after: { status, resolution_note: resolutionNote },
            context: {
              requestId: req.id,
              method: req.method,
              url: req.url,
              bulk_group: bulkGroup,
              target_player_id: targetPlayerId,
            },
            statusCode: 200,
          });
        }
        return rows;
      });

      if (updated.length === 0) {
        reply.code(404);
        return { error: 'no_pending_reports' };
      }

      for (const report of updated) {
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
      }

      // Notify each distinct reporter once, concurrently: every notify can
      // wait up to the RCON command timeout, so a sequential loop made the
      // request last N x that timeout. Best-effort.
      const reporterServer = new Map<string, string>();
      for (const report of updated) {
        if (report.reporterPlayerId && !reporterServer.has(report.reporterPlayerId)) {
          reporterServer.set(report.reporterPlayerId, report.serverId);
        }
      }
      await Promise.allSettled(
        [...reporterServer].map(([reporterPlayerId, serverId]) =>
          notifyReporter(app.db, app.redis, {
            serverId,
            reporterPlayerId,
            template: 'resolved',
            actorPlayerId: handlerPlayerId,
          }),
        ),
      );

      // Recompute reporter trust metrics once per distinct reporter among the
      // bulk-resolved reports (REPORT-5, #115). Best-effort.
      const distinctReporters = new Set(
        updated.map((report) => report.reporterPlayerId).filter((id): id is string => id != null),
      );
      for (const reporterPlayerId of distinctReporters) {
        await recomputeReporterStats(app.db, app.redis, reporterPlayerId).catch(() => undefined);
      }

      return { ok: true, resolved_ids: updated.map((report) => report.id) };
    },
  );
};

export default reportActionsRoutes;
