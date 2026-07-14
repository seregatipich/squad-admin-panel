import type { DatabaseClient } from '@squad/db';
import {
  PLAYER_LINK_STATUSES,
  PLAYER_LINK_TYPES,
  type PlayerLinkRow,
  playerLinks,
  players,
} from '@squad/db/schema';
import { eq, or } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { writeAuditEntry } from '../lib/audit.js';

const playerIdParams = z.object({ playerId: z.string().uuid() });
const linkIdParams = z.object({ linkId: z.string().uuid() });

const createBody = z.object({
  other_player_id: z.string().uuid(),
  link_type: z.enum(PLAYER_LINK_TYPES),
  status: z.enum(PLAYER_LINK_STATUSES).default('confirmed'),
  note: z.string().trim().max(2000).optional(),
  evidence_snapshot: z.record(z.string(), z.unknown()).optional(),
});

const patchBody = z
  .object({
    link_type: z.enum(PLAYER_LINK_TYPES).optional(),
    status: z.enum(PLAYER_LINK_STATUSES).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty_update' });

interface PlayerSummaryRow {
  id: string;
  current_name: string;
  steam_id64: string | null;
}

function serializeLink(
  row: PlayerLinkRow,
  otherPlayer: PlayerSummaryRow | null,
  createdBy: { player_id: string; name: string } | null,
) {
  return {
    id: row.id,
    link_type: row.linkType,
    status: row.status,
    note: row.note,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    created_by: createdBy,
    other_player: otherPlayer,
  };
}

function snapshot(row: PlayerLinkRow) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

async function auditMutation(
  db: DatabaseClient,
  req: FastifyRequest,
  input: { action: string; targetId: string; before: unknown; after: unknown },
): Promise<void> {
  if (!req.user) return;
  await writeAuditEntry(db, {
    actor: { kind: 'steam', playerId: req.user.playerId, tokenId: req.apiTokenId ?? null },
    actorIp: req.ip ?? null,
    actionType: input.action,
    targetType: 'player_link',
    targetId: input.targetId,
    before: input.before,
    after: input.after,
    context: { requestId: req.id, method: req.method, url: req.url },
  });
}

/**
 * ALT-2 (issue #120): manual confirm/reject verdicts on player pairs, the
 * durable counterpart to the ephemeral ALT-1 candidate engine
 * (`player-alt-candidates.ts`). Confirming from either side of a pair
 * produces the identical canonical row (`player_a_id < player_b_id`); a
 * second decision for the same pair 409s. There is deliberately no DELETE —
 * flipping a verdict is a PATCH `status` update, so the decision history
 * (and its `audit_log` trail) is never lost. All three routes are gated on
 * the fine `player:view_ips` permission, same as the candidate engine.
 */
const playerLinksRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  async function loadPlayerSummary(id: string): Promise<PlayerSummaryRow | null> {
    const rows = await app.db
      .select({
        id: players.id,
        current_name: players.canonicalName,
        steam_id64: players.steamId64,
      })
      .from(players)
      .where(eq(players.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      current_name: row.current_name,
      steam_id64: row.steam_id64?.toString() ?? null,
    };
  }

  async function loadCreatedBy(
    id: string | null,
  ): Promise<{ player_id: string; name: string } | null> {
    if (!id) return null;
    const rows = await app.db
      .select({ id: players.id, name: players.canonicalName })
      .from(players)
      .where(eq(players.id, id))
      .limit(1);
    const row = rows[0];
    return row ? { player_id: row.id, name: row.name } : null;
  }

  fast.post(
    '/api/v1/players/:playerId/links',
    {
      schema: { params: playerIdParams, body: createBody },
      config: { permissions: ['player:view_ips'], audit: false },
    },
    async (req, reply) => {
      const { playerId } = req.params;
      const {
        other_player_id: otherPlayerId,
        link_type,
        status,
        note,
        evidence_snapshot,
      } = req.body;

      if (otherPlayerId === playerId) {
        reply.code(400);
        return { error: 'self_link' };
      }

      const [target, other] = await Promise.all([
        loadPlayerSummary(playerId),
        loadPlayerSummary(otherPlayerId),
      ]);
      if (!target || !other) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const [playerAId, playerBId] =
        playerId < otherPlayerId ? [playerId, otherPlayerId] : [otherPlayerId, playerId];

      // biome-ignore lint/style/noNonNullAssertion: guaranteed by the player:view_ips permission gate
      const actorId = req.user!.playerId;
      const result = await app.db
        .insert(playerLinks)
        .values({
          playerAId,
          playerBId,
          linkType: link_type,
          status,
          note: note ?? null,
          evidenceSnapshot: evidence_snapshot ?? null,
          createdBy: actorId,
        })
        .onConflictDoNothing({ target: [playerLinks.playerAId, playerLinks.playerBId] })
        .returning();
      const inserted = result[0];
      if (!inserted) {
        reply.code(409);
        return { error: 'link_exists' };
      }

      reply.code(201);
      await auditMutation(app.db, req, {
        action: 'player_link.create',
        targetId: inserted.id,
        before: null,
        after: snapshot(inserted),
      });

      const createdBy = await loadCreatedBy(inserted.createdBy);
      return serializeLink(inserted, other, createdBy);
    },
  );

  fast.get(
    '/api/v1/players/:playerId/links',
    {
      schema: { params: playerIdParams },
      config: { permissions: ['player:view_ips'], audit: false },
    },
    async (req) => {
      const { playerId } = req.params;
      const rows = await app.db
        .select()
        .from(playerLinks)
        .where(or(eq(playerLinks.playerAId, playerId), eq(playerLinks.playerBId, playerId)));

      const otherIds = rows.map((row) =>
        row.playerAId === playerId ? row.playerBId : row.playerAId,
      );
      const createdByIds = rows
        .map((row) => row.createdBy)
        .filter((id): id is string => id != null);
      const uniqueIds = Array.from(new Set([...otherIds, ...createdByIds]));
      const summaryRows = uniqueIds.length
        ? await app.db
            .select({
              id: players.id,
              current_name: players.canonicalName,
              steam_id64: players.steamId64,
            })
            .from(players)
            .where(or(...uniqueIds.map((id) => eq(players.id, id))))
        : [];
      const summaryById = new Map(
        summaryRows.map((row) => [
          row.id,
          {
            id: row.id,
            current_name: row.current_name,
            steam_id64: row.steam_id64?.toString() ?? null,
          },
        ]),
      );

      const links = rows.map((row) => {
        const otherId = row.playerAId === playerId ? row.playerBId : row.playerAId;
        const otherPlayer = summaryById.get(otherId) ?? null;
        const createdBySummary = row.createdBy ? summaryById.get(row.createdBy) : null;
        const createdBy = createdBySummary
          ? { player_id: createdBySummary.id, name: createdBySummary.current_name }
          : null;
        return serializeLink(row, otherPlayer, createdBy);
      });

      return { links };
    },
  );

  fast.patch(
    '/api/v1/player-links/:linkId',
    {
      schema: { params: linkIdParams, body: patchBody },
      config: { permissions: ['player:view_ips'], audit: false },
    },
    async (req, reply) => {
      const { linkId } = req.params;
      const existingRows = await app.db
        .select()
        .from(playerLinks)
        .where(eq(playerLinks.id, linkId))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        reply.code(404);
        return { error: 'link_not_found' };
      }

      const updates: Partial<typeof playerLinks.$inferInsert> = { updatedAt: new Date() };
      if (req.body.link_type !== undefined) updates.linkType = req.body.link_type;
      if (req.body.status !== undefined) updates.status = req.body.status;
      if (req.body.note !== undefined) updates.note = req.body.note;

      const updateResult = await app.db
        .update(playerLinks)
        .set(updates)
        .where(eq(playerLinks.id, linkId))
        .returning();
      const updated = updateResult[0];
      if (!updated) {
        reply.code(500);
        return { error: 'update_failed' };
      }

      await auditMutation(app.db, req, {
        action: 'player_link.update',
        targetId: existing.id,
        before: snapshot(existing),
        after: snapshot(updated),
      });

      // PATCH has no "viewpoint" player (unlike POST/GET, which are scoped to
      // one side of the pair) — return both sides' summaries explicitly.
      const [playerA, playerB, createdBy] = await Promise.all([
        loadPlayerSummary(updated.playerAId),
        loadPlayerSummary(updated.playerBId),
        loadCreatedBy(updated.createdBy),
      ]);
      return {
        id: updated.id,
        link_type: updated.linkType,
        status: updated.status,
        note: updated.note,
        created_at: updated.createdAt.toISOString(),
        updated_at: updated.updatedAt.toISOString(),
        created_by: createdBy,
        player_a: playerA,
        player_b: playerB,
      };
    },
  );
};

export default playerLinksRoutes;
