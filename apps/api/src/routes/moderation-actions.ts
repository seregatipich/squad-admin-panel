import { mediaFiles, mediaLinks, moderationActions, players, servers } from '@squad/db/schema';
import { PANEL_CONFIGS_ROOT } from '@squad/shared-config';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { removeBanLines } from '../lib/bans-cfg.js';
import {
  enforceModerationAction,
  markBansReverted,
  type PlayerIdentity,
  publishModerationEvent,
} from '../lib/moderation-enforce.js';
import { type ReloadOutcome, writeVersion } from './server-configs.js';

const LIMIT_MAX = 200;
const LIMIT_DEFAULT = 50;
/** Read-verify-write attempts before giving up on a racing Bans.cfg edit. */
const MAX_BANS_CFG_ATTEMPTS = 3;
/** Evidence files attachable to a single action, mirroring `reports.ts`'s per-report cap. */
const EVIDENCE_MAX = 10;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const actionIdParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
  action_type: z.string().trim().min(1).max(64).optional(),
  server_id: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
});

const actionBody = z.object({
  server_id: z.string().uuid(),
  action_type: z.enum(['warn', 'kick', 'ban']),
  reason: z.string().trim().min(1).max(300),
  ban_length: z
    .string()
    .trim()
    .regex(/^\d+[smhdwMy]?$/, 'invalid ban_length')
    .default('0'),
  source: z.enum(['player_card', 'live_players']).default('player_card'),
  /**
   * Evidence (MOD-3, #60): ids of existing, non-deleted `media_files` rows to
   * attach to the resulting ledger row. Stored as `media_links` — the
   * canonical polymorphic evidence store (VIDEO-2, #158) — never as a column
   * on `moderation_actions`.
   */
  evidence_media_ids: z.array(z.string().uuid()).max(EVIDENCE_MAX).default([]),
});

const revertBody = z.object({
  reason: z.string().trim().min(1).max(300),
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

/** One `media_files` row attached to a moderation action, as serialized into `evidence[]`. */
interface EvidenceItem {
  id: string;
  kind: string;
  external_url: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  title: string | null;
  linked_by_player_id: string | null;
  linked_at: string;
}

function bansCfgPath(serverId: string): string {
  return `${PANEL_CONFIGS_ROOT}/${serverId}/ServerConfig/Bans.cfg`;
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

/**
 * Guards a warn/kick/ban/unban write route. Mirrors `external-bans.ts`'s
 * `localBanGuard`: warn/kick require the role's live-Squad `kick`
 * permission, ban/unban require `ban` — the same squad permission that
 * gates the catalog keys in `derivePanelPermissions` (`rbac.ts`), checked
 * again here since the route, not just the catalog, is the actual
 * enforcement point.
 */
function moderationWriteGuard(
  req: FastifyRequest,
  reply: FastifyReply,
  actionType: 'warn' | 'kick' | 'ban',
): { error: string; required?: string } | null {
  const denied = panelGuard(req, reply);
  if (denied) return denied;
  const required = actionType === 'ban' ? 'ban' : 'kick';
  if (!req.user?.permissions.squadPermissions.has(required)) {
    reply.code(403);
    return { error: 'forbidden', required };
  }
  return null;
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function serializeActionRow(row: ModerationActionApiRow, evidence: EvidenceItem[] = []) {
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
    evidence,
    evidence_count: evidence.length,
  };
}

/**
 * Loads the active (non-soft-deleted) media evidence attached to the given
 * moderation actions, keyed by action id. One query for the whole page, in the
 * shape of `reports.ts`'s `loadEvidenceForReports` — a per-action lookup would
 * be an N+1 on every history read.
 *
 * A `media_links` row pointing at a soft-deleted `media_files` row is skipped
 * rather than removed: detaching is an explicit operator action, and undeleting
 * the file must bring its evidence back.
 */
async function loadEvidenceForActions(
  app: Parameters<FastifyPluginAsync>[0],
  actionIds: string[],
): Promise<Map<string, EvidenceItem[]>> {
  const byAction = new Map<string, EvidenceItem[]>();
  if (actionIds.length === 0) return byAction;

  const rows = await app.db
    .select({
      actionId: mediaLinks.entityId,
      linkedByPlayerId: mediaLinks.linkedByPlayerId,
      linkedAt: mediaLinks.createdAt,
      id: mediaFiles.id,
      kind: mediaFiles.kind,
      externalUrl: mediaFiles.externalUrl,
      originalFilename: mediaFiles.originalFilename,
      mimeType: mediaFiles.mimeType,
      sizeBytes: mediaFiles.sizeBytes,
      title: mediaFiles.title,
    })
    .from(mediaLinks)
    .innerJoin(mediaFiles, eq(mediaFiles.id, mediaLinks.mediaId))
    .where(
      and(
        eq(mediaLinks.entityType, 'moderation_action'),
        inArray(mediaLinks.entityId, actionIds),
        isNull(mediaFiles.deletedAt),
      ),
    )
    .orderBy(mediaLinks.createdAt);

  for (const row of rows) {
    const item: EvidenceItem = {
      id: row.id,
      kind: row.kind,
      external_url: row.externalUrl,
      original_filename: row.originalFilename,
      mime_type: row.mimeType,
      size_bytes: row.sizeBytes,
      title: row.title,
      linked_by_player_id: row.linkedByPlayerId,
      linked_at: row.linkedAt.toISOString(),
    };
    const existing = byAction.get(row.actionId);
    if (existing) existing.push(item);
    else byAction.set(row.actionId, [item]);
  }
  return byAction;
}

async function fetchActionRows(
  app: Parameters<FastifyPluginAsync>[0],
  where: SQL,
  limit: number,
): Promise<ModerationActionApiRow[]> {
  return (await app.db.execute(sql`
    SELECT
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
    FROM moderation_actions ma
    LEFT JOIN players ap ON ap.id = ma.author_player_id
    LEFT JOIN servers s ON s.id = ma.server_id
    WHERE ${where}
    ORDER BY ma.created_at DESC, ma.id DESC
    LIMIT ${limit}
  `)) as unknown as ModerationActionApiRow[];
}

/**
 * Moderation history and enforcement routes: the per-player ledger
 * (`moderation_actions`) that backs the "moderation history" block on the
 * player card, plus (MOD-2, #59) the write path that actually performs
 * warn/kick/ban from the panel and the revert path that unbans a player —
 * removing their line(s) from `Bans.cfg` and marking their ban rows
 * reverted. Gated on `panel_access`; the write and revert routes
 * additionally require the role's live-Squad `kick`/`ban` permission.
 *
 * Evidence (MOD-3, #60) rides along on the write path — `evidence_media_ids`
 * in the body becomes `media_links` rows with `entity_type='moderation_action'`
 * — and comes back out on every read as `evidence[]`/`evidence_count`. The
 * link table is the canonical store (VIDEO-2, #158); `moderation_actions`
 * itself carries no evidence column.
 */
const moderationActionsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/moderation-actions',
    { schema: { params: playerIdParams, querystring: listQuery }, config: { audit: false } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const { playerId } = req.params;
      const { limit, action_type: actionType, server_id: serverId, cursor } = req.query;

      const conditions: SQL[] = [sql`ma.player_id = ${playerId}`];
      if (actionType) conditions.push(sql`ma.action_type = ${actionType}`);
      if (serverId) conditions.push(sql`ma.server_id = ${serverId}`);
      if (cursor) {
        conditions.push(
          sql`(ma.created_at, ma.id) < (SELECT created_at, id FROM moderation_actions WHERE id = ${cursor})`,
        );
      }

      const rows = await fetchActionRows(app, sql.join(conditions, sql` AND `), limit);
      const evidenceByAction = await loadEvidenceForActions(
        app,
        rows.map((row) => row.id),
      );

      return {
        actions: rows.map((row) => serializeActionRow(row, evidenceByAction.get(row.id) ?? [])),
      };
    },
  );

  /**
   * Enforces a warn/kick/ban from the player card (or, per `source`, the
   * live-players list) through `enforceModerationAction`: an RCON command
   * via worker-rcon, then the ledger row and EVT-1 publish, only once the
   * command is confirmed applied.
   */
  fast.post(
    '/api/v1/players/:playerId/moderation-actions',
    {
      schema: { params: playerIdParams, body: actionBody },
      config: { audit: { action: 'moderation.action', resource: 'player' } },
    },
    async (req, reply) => {
      const denied = moderationWriteGuard(req, reply, req.body.action_type);
      if (denied) return denied;

      const [player] = await app.db
        .select({
          steamId64: players.steamId64,
          eosId: players.eosId,
          name: players.canonicalName,
        })
        .from(players)
        .where(eq(players.id, req.params.playerId))
        .limit(1);
      if (!player) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const [server] = await app.db
        .select({ id: servers.id })
        .from(servers)
        .where(and(eq(servers.id, req.body.server_id), isNull(servers.deletedAt)))
        .limit(1);
      if (!server) {
        reply.code(404);
        return { error: 'server_not_found' };
      }

      const steamId64 = player.steamId64 !== null ? player.steamId64.toString() : null;
      const identity: PlayerIdentity = { eosId: player.eosId, steamId64, name: player.name };
      if (!identity.eosId && !identity.steamId64) {
        reply.code(400);
        return { error: 'target_identity_missing' };
      }

      // Evidence is validated *before* enforcement on purpose: a bad media id
      // must not leave a player banned in-game with no ledger row to revert.
      const evidenceIds = Array.from(new Set(req.body.evidence_media_ids));
      if (evidenceIds.length > 0) {
        const activeMedia = await app.db
          .select({ id: mediaFiles.id })
          .from(mediaFiles)
          .where(and(inArray(mediaFiles.id, evidenceIds), isNull(mediaFiles.deletedAt)));
        const activeIds = new Set(activeMedia.map((row) => row.id));
        const missing = evidenceIds.find((id) => !activeIds.has(id));
        if (missing) {
          reply.code(400);
          return { error: 'evidence_media_not_found', media_id: missing };
        }
      }

      // biome-ignore lint/style/noNonNullAssertion: moderationWriteGuard rejects unauthenticated callers
      const actor = req.user!;
      const result = await enforceModerationAction(app, {
        serverId: server.id,
        playerId: req.params.playerId,
        identity,
        actionType: req.body.action_type,
        reason: req.body.reason,
        banLength: req.body.ban_length,
        actorPlayerId: actor.playerId,
        actorName: actor.canonicalName,
        source: req.body.source,
      });

      if (!result.ok) {
        const { outcome } = result;
        reply.code(502);
        if (!outcome.attempted || !outcome.ok) {
          return {
            error: 'action_failed',
            reason: outcome.reason,
            detail: outcome.attempted ? outcome.detail : undefined,
          };
        }
        // Structurally excluded by enforceModerationAction's own contract (it
        // only returns `ok: false` when the outcome itself was not attempted
        // or not ok) — TypeScript can't express that across the return-type
        // boundary, so this branch stays for exhaustiveness.
        return { error: 'action_failed' };
      }

      if (evidenceIds.length > 0) {
        await app.db.insert(mediaLinks).values(
          evidenceIds.map((mediaId) => ({
            id: uuidv7(),
            mediaId,
            entityType: 'moderation_action',
            entityId: result.actionId,
            linkedByPlayerId: actor.playerId,
          })),
        );
      }

      const rows = await fetchActionRows(app, sql`ma.id = ${result.actionId}`, 1);
      const row = rows[0];
      if (!row) throw new Error('moderation action row missing immediately after insert');
      const evidenceByAction = await loadEvidenceForActions(app, [row.id]);

      return { action: serializeActionRow(row, evidenceByAction.get(row.id) ?? []) };
    },
  );

  /**
   * Unbans a player: removes their `Banned:` line(s) from `Bans.cfg`
   * (read-verify-write, retried up to {@link MAX_BANS_CFG_ATTEMPTS} times
   * against a racing concurrent edit before giving up with `409
   * bans_cfg_conflict`), marks every active ban row for that player+server
   * reverted, inserts an `unban` ledger row, and publishes its EVT-1
   * envelope. A file with no matching line is left untouched — no write is
   * attempted — but the ledger is still updated, since the database, not
   * the file, is the source of truth for whether a player is banned.
   */
  fast.post(
    '/api/v1/moderation-actions/:id/revert',
    {
      schema: { params: actionIdParams, body: revertBody },
      config: { audit: { action: 'moderation.revert', resource: 'player' } },
    },
    async (req, reply) => {
      const denied = moderationWriteGuard(req, reply, 'ban');
      if (denied) return denied;

      const [target] = await app.db
        .select({
          id: moderationActions.id,
          playerId: moderationActions.playerId,
          serverId: moderationActions.serverId,
          actionType: moderationActions.actionType,
        })
        .from(moderationActions)
        .where(eq(moderationActions.id, req.params.id))
        .limit(1);
      if (!target) {
        reply.code(404);
        return { error: 'moderation_action_not_found' };
      }
      if (target.actionType !== 'ban') {
        reply.code(400);
        return { error: 'not_a_ban_action' };
      }
      if (!target.serverId) {
        reply.code(409);
        return { error: 'server_missing' };
      }
      const serverId = target.serverId;

      const [player] = await app.db
        .select({ steamId64: players.steamId64, eosId: players.eosId, name: players.canonicalName })
        .from(players)
        .where(eq(players.id, target.playerId))
        .limit(1);
      if (!player) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      const steamId64 = player.steamId64 !== null ? player.steamId64.toString() : null;

      // biome-ignore lint/style/noNonNullAssertion: moderationWriteGuard rejects unauthenticated callers
      const actor = req.user!;

      let removed: string[] = [];
      let reload: ReloadOutcome = { applied: false, reason: 'not_hot_reload' };
      let conflict = false;

      if (steamId64 !== null) {
        const path = bansCfgPath(serverId);
        conflict = true;
        for (let attempt = 1; attempt <= MAX_BANS_CFG_ATTEMPTS; attempt++) {
          let current: string;
          try {
            current = (await app.bridge.fileRead({ path })).content;
          } catch {
            current = '';
          }
          const result = removeBanLines(current, steamId64);
          if (result.removed.length === 0) {
            removed = [];
            conflict = false;
            break;
          }

          const writeResult = await writeVersion(
            app,
            serverId,
            'Bans.cfg',
            result.content,
            `Unban ${steamId64}: ${req.body.reason}`,
            actor.playerId,
            req.ip ?? null,
          );

          let verify: string;
          try {
            verify = (await app.bridge.fileRead({ path })).content;
          } catch {
            verify = '';
          }
          if (verify === result.content) {
            removed = result.removed;
            if ('reload' in writeResult && writeResult.reload) reload = writeResult.reload;
            conflict = false;
            break;
          }
        }
        if (conflict) {
          reply.code(409);
          return { error: 'bans_cfg_conflict' };
        }
      }

      const revertedActionIds = await markBansReverted(app, {
        playerId: target.playerId,
        serverId,
        actorPlayerId: actor.playerId,
        targetActionId: target.id,
      });

      const identity: PlayerIdentity = { eosId: player.eosId, steamId64, name: player.name };
      const [inserted] = await app.db
        .insert(moderationActions)
        .values({
          playerId: target.playerId,
          serverId,
          actionType: 'unban',
          authorPlayerId: actor.playerId,
          reason: req.body.reason,
          context: { removed_ban_lines: removed, reverted_action_ids: revertedActionIds },
        })
        .returning({ id: moderationActions.id });
      if (!inserted) throw new Error('unban moderation action insert returned no row');

      await publishModerationEvent(app, {
        actionId: inserted.id,
        actionType: 'unban',
        actorPlayerId: actor.playerId,
        actorName: actor.canonicalName,
        playerId: target.playerId,
        player: identity,
        serverId,
        reportId: null,
        reason: req.body.reason,
        duration: null,
      });

      const rows = await fetchActionRows(app, sql`ma.id = ${inserted.id}`, 1);
      const row = rows[0];
      if (!row) throw new Error('unban moderation action row missing immediately after insert');

      // A just-inserted `unban` row cannot have evidence attached yet, so the
      // serializer's empty default is exact — no evidence query is issued.
      return {
        action: serializeActionRow(row),
        removed_lines: removed.length,
        reload,
      };
    },
  );
};

export default moderationActionsRoutes;
