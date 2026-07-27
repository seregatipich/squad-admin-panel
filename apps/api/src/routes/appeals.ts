import { banAppeals, moderationActions, players } from '@squad/db/schema';
import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';
import type { PlayerIdentity } from '../lib/moderation-enforce.js';
import { unbanPlayerOnServer } from './moderation-actions.js';

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const NOTE_MAX = 2000;

type AppealStatus = 'pending' | 'in_review' | 'approved' | 'rejected';

/**
 * The status graph, expressed once. Terminal statuses map to an empty list,
 * which is what separates `409 appeal_already_decided` (nothing may follow)
 * from `400 invalid_transition` (this particular hop is not allowed).
 */
const ALLOWED_TRANSITIONS: Record<AppealStatus, AppealStatus[]> = {
  pending: ['in_review', 'approved', 'rejected'],
  in_review: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

const listQuery = z.object({
  status: z.enum(['pending', 'in_review', 'approved', 'rejected']).optional(),
  player_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

const idParams = z.object({ id: z.string().uuid() });

const patchBody = z.object({
  status: z.enum(['in_review', 'approved', 'rejected']),
  decision_note: z.string().trim().max(NOTE_MAX).optional(),
  internal_note: z.string().trim().max(NOTE_MAX).optional(),
});

interface AppealRow {
  id: string;
  number: string | number;
  status: string;
  steamId64: bigint;
  body: string;
  contact: string | null;
  decisionNote: string | null;
  internalNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
  playerId: string | null;
  playerName: string | null;
  playerSteamId64: bigint | null;
  actionId: string | null;
  actionType: string | null;
  actionReason: string | null;
  actionCreatedAt: Date | null;
  actionContext: unknown;
  handlerId: string | null;
  handlerName: string | null;
}

function serializeAppeal(row: AppealRow) {
  const context = (row.actionContext ?? {}) as { ban_length?: unknown };
  return {
    id: row.id,
    number: Number(row.number),
    status: row.status,
    steam_id64: row.steamId64.toString(),
    body: row.body,
    contact: row.contact,
    decision_note: row.decisionNote,
    internal_note: row.internalNote,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    decided_at: row.decidedAt ? row.decidedAt.toISOString() : null,
    player: row.playerId
      ? {
          id: row.playerId,
          name: row.playerName,
          steam_id64: row.playerSteamId64 != null ? row.playerSteamId64.toString() : null,
        }
      : null,
    moderation_action:
      row.actionId && row.actionCreatedAt
        ? {
            id: row.actionId,
            action_type: row.actionType,
            reason: row.actionReason,
            created_at: row.actionCreatedAt.toISOString(),
            ban_length: typeof context.ban_length === 'string' ? context.ban_length : null,
          }
        : null,
    handler: row.handlerId ? { id: row.handlerId, name: row.handlerName } : null,
  };
}

function isAppealStatus(value: string): value is AppealStatus {
  return (
    value === 'pending' || value === 'in_review' || value === 'approved' || value === 'rejected'
  );
}

/**
 * Panel half of the ban-appeal portal (MOD-5, #62): the review queue and the
 * status transitions that resolve it. Gated on the `mod:unban` catalogue key,
 * which MOD-2 (#59) put behind the role's live-Squad `ban` permission — so a
 * panel user who may not ban may not lift a ban through an appeal either.
 *
 * Approving an appeal *is* an unban and reuses the MOD-2 revert path
 * verbatim through {@link unbanPlayerOnServer}: `Bans.cfg` line removal,
 * `moderation_actions.reverted_at`/`reverted_by`, an `unban` ledger row and
 * the `moderation.unban` EVT-1 envelope that discord-notify renders. Because
 * the ledger is what `GET /api/v1/public/banlist` reads, an approved appeal
 * also drops the player out of outbound ban federation.
 *
 * Audit is written by hand (`config.audit: false`) so every transition
 * carries real before/after snapshots, matching `whitelist-applications.ts`.
 */
const appealsRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const appellant = alias(players, 'appeal_player');
  const handler = alias(players, 'appeal_handler');

  function baseSelection() {
    return app.db
      .select({
        id: banAppeals.id,
        number: banAppeals.number,
        status: banAppeals.status,
        steamId64: banAppeals.steamId64,
        body: banAppeals.body,
        contact: banAppeals.contact,
        decisionNote: banAppeals.decisionNote,
        internalNote: banAppeals.internalNote,
        createdAt: banAppeals.createdAt,
        updatedAt: banAppeals.updatedAt,
        decidedAt: banAppeals.decidedAt,
        playerId: appellant.id,
        playerName: appellant.canonicalName,
        playerSteamId64: appellant.steamId64,
        actionId: moderationActions.id,
        actionType: moderationActions.actionType,
        actionReason: moderationActions.reason,
        actionCreatedAt: moderationActions.createdAt,
        actionContext: moderationActions.context,
        handlerId: handler.id,
        handlerName: handler.canonicalName,
      })
      .from(banAppeals)
      .leftJoin(appellant, eq(appellant.id, banAppeals.playerId))
      .leftJoin(moderationActions, eq(moderationActions.id, banAppeals.moderationActionId))
      .leftJoin(handler, eq(handler.id, banAppeals.handlerPlayerId));
  }

  async function loadAppeal(id: string): Promise<AppealRow | null> {
    const rows = (await baseSelection()
      .where(eq(banAppeals.id, id))
      .limit(1)) as unknown as AppealRow[];
    return rows[0] ?? null;
  }

  fast.get(
    '/api/v1/appeals',
    {
      schema: { querystring: listQuery },
      config: { permissions: ['mod:unban'], audit: false },
    },
    async (req) => {
      const { page, page_size: pageSize } = req.query;
      const filters: SQL[] = [];
      if (req.query.status) filters.push(eq(banAppeals.status, req.query.status));
      if (req.query.player_id) filters.push(eq(banAppeals.playerId, req.query.player_id));
      const where = filters.length > 0 ? and(...filters) : undefined;

      const countRows = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(banAppeals)
        .where(where);

      const rows = (await baseSelection()
        .where(where)
        .orderBy(desc(banAppeals.createdAt), desc(banAppeals.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)) as unknown as AppealRow[];

      return {
        items: rows.map(serializeAppeal),
        total: countRows[0]?.total ?? 0,
        page,
        page_size: pageSize,
      };
    },
  );

  fast.get(
    '/api/v1/appeals/:id',
    { schema: { params: idParams }, config: { permissions: ['mod:unban'], audit: false } },
    async (req, reply) => {
      const row = await loadAppeal(req.params.id);
      if (!row) {
        reply.code(404);
        return { error: 'appeal_not_found' };
      }
      return serializeAppeal(row);
    },
  );

  /**
   * Moves an appeal through the status graph. Approving additionally reverts
   * every active ban the appellant still holds, one call to
   * {@link unbanPlayerOnServer} per server they are banned on — Squad appends
   * a fresh `Banned:` line per `AdminBan`, and the appellant may be banned on
   * more than one server, so anything less would leave them banned after a
   * decision that says otherwise.
   */
  fast.patch(
    '/api/v1/appeals/:id',
    {
      schema: { params: idParams, body: patchBody },
      config: { permissions: ['mod:unban'], audit: false },
    },
    async (req, reply) => {
      // biome-ignore lint/style/noNonNullAssertion: the mod:unban gate guarantees req.user
      const actor = req.user!;

      const existing = await loadAppeal(req.params.id);
      if (!existing) {
        reply.code(404);
        return { error: 'appeal_not_found' };
      }
      const current = existing.status;
      if (!isAppealStatus(current)) throw new Error(`unknown ban_appeals.status: ${current}`);

      const allowed = ALLOWED_TRANSITIONS[current];
      if (allowed.length === 0) {
        reply.code(409);
        return { error: 'appeal_already_decided' };
      }
      if (!allowed.includes(req.body.status)) {
        reply.code(400);
        return { error: 'invalid_transition' };
      }

      const before = serializeAppeal(existing);
      const decided = req.body.status === 'approved' || req.body.status === 'rejected';

      let revert: {
        reverted_action_ids: string[];
        unban_action_ids: string[];
        removed_lines: number;
      } | null = null;

      if (req.body.status === 'approved') {
        const outcome = await revertAppellantBans(
          existing,
          { playerId: actor.playerId, canonicalName: actor.canonicalName },
          req.ip ?? null,
          `Апелляция #${Number(existing.number)} одобрена`,
        );
        if (!outcome.ok) {
          reply.code(409);
          return { error: outcome.error };
        }
        revert = outcome.summary;
      }

      await app.db
        .update(banAppeals)
        .set({
          status: req.body.status,
          handlerPlayerId: actor.playerId,
          decisionNote: req.body.decision_note ?? existing.decisionNote,
          internalNote: req.body.internal_note ?? existing.internalNote,
          decidedAt: decided ? new Date() : existing.decidedAt,
          updatedAt: new Date(),
        })
        .where(eq(banAppeals.id, existing.id));

      const updated = await loadAppeal(existing.id);
      if (!updated) throw new Error('ban_appeals row missing immediately after update');
      const after = serializeAppeal(updated);

      await writeAuditEntry(app.db, {
        actor: { kind: 'steam', playerId: actor.playerId, tokenId: req.apiTokenId ?? null },
        actorIp: req.ip ?? null,
        actionType: 'appeal.status_change',
        targetType: 'ban_appeal',
        targetId: existing.id,
        before: { status: before.status, decision_note: before.decision_note },
        after: { status: after.status, decision_note: after.decision_note },
        context: {
          requestId: req.id,
          method: req.method,
          url: req.url,
          player_id: existing.playerId,
          moderation_action_id: existing.actionId,
        },
        statusCode: 200,
      });

      if (revert) {
        await writeAuditEntry(app.db, {
          actor: { kind: 'steam', playerId: actor.playerId, tokenId: req.apiTokenId ?? null },
          actorIp: req.ip ?? null,
          actionType: 'appeal.unban',
          targetType: 'ban_appeal',
          targetId: existing.id,
          after: { status: after.status },
          context: {
            requestId: req.id,
            method: req.method,
            url: req.url,
            player_id: existing.playerId,
            reverted_action_ids: revert.reverted_action_ids,
            unban_action_ids: revert.unban_action_ids,
          },
          statusCode: 200,
        });
      }

      app.liveBus.publish({
        type: 'appeal.updated',
        ts: new Date().toISOString(),
        data: { appeal_id: after.id, number: after.number, status: after.status },
      });

      return { appeal: after, revert };
    },
  );

  /**
   * Reverts every active ban the appellant still holds, one shared MOD-2
   * unban per server they are banned on, and reports what changed.
   *
   * An appeal whose SteamID64 never resolved to a player, or whose player
   * holds no active ban, is a no-op that still succeeds: the decision belongs
   * to the moderator and there is simply nothing left to lift. A
   * `bans_cfg_conflict` on any server aborts the whole approval — the caller
   * turns it into `409` and leaves the appeal open to retry.
   */
  async function revertAppellantBans(
    appeal: AppealRow,
    actor: { playerId: string; canonicalName: string },
    actorIp: string | null,
    reason: string,
  ): Promise<
    | { ok: false; error: 'bans_cfg_conflict' }
    | {
        ok: true;
        summary: {
          reverted_action_ids: string[];
          unban_action_ids: string[];
          removed_lines: number;
        };
      }
  > {
    const summary = {
      reverted_action_ids: [] as string[],
      unban_action_ids: [] as string[],
      removed_lines: 0,
    };
    if (!appeal.playerId) return { ok: true, summary };
    const playerId = appeal.playerId;

    const [identityRow] = await app.db
      .select({ eosId: players.eosId, steamId64: players.steamId64, name: players.canonicalName })
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);
    if (!identityRow) return { ok: true, summary };
    const identity: PlayerIdentity = {
      eosId: identityRow.eosId,
      steamId64: identityRow.steamId64 != null ? identityRow.steamId64.toString() : null,
      name: identityRow.name,
    };

    const activeBans = await app.db
      .select({ id: moderationActions.id, serverId: moderationActions.serverId })
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.playerId, playerId),
          eq(moderationActions.actionType, 'ban'),
          isNull(moderationActions.revertedAt),
        ),
      );

    // One unban per distinct server: both `markBansReverted` and the
    // `Bans.cfg` it mirrors are scoped to a single server's config.
    const targetBanPerServer = new Map<string, string>();
    for (const ban of activeBans) {
      if (!ban.serverId) continue;
      if (!targetBanPerServer.has(ban.serverId)) targetBanPerServer.set(ban.serverId, ban.id);
    }

    for (const [serverId, targetActionId] of targetBanPerServer) {
      const result = await unbanPlayerOnServer(app, {
        playerId,
        serverId,
        identity,
        actorPlayerId: actor.playerId,
        actorName: actor.canonicalName,
        actorIp,
        reason,
        targetActionId,
        extraContext: { appeal_id: appeal.id, appeal_number: Number(appeal.number) },
      });
      if (!result.ok) return { ok: false, error: result.error };
      summary.reverted_action_ids.push(...result.revertedActionIds);
      summary.unban_action_ids.push(result.unbanActionId);
      summary.removed_lines += result.removedLines.length;
    }

    return { ok: true, summary };
  }
};

export default appealsRoutes;
