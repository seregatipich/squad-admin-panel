import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@squad/db';
import {
  PLAYER_LINK_STATUSES,
  PLAYER_LINK_TYPES,
  type PlayerLinkRow,
  playerLinks,
  players,
} from '@squad/db/schema';
import { desc, eq, inArray, or } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type AuditTransaction, writeAuditEntry } from '../lib/audit.js';

/**
 * Upper bound on the links `GET /players/:playerId/links` returns, newest
 * first; the response sets `truncated` when a player has more.
 */
export const PLAYER_LINKS_LIMIT = 500;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const linkIdParams = z.object({ linkId: z.string().uuid() });

/**
 * Largest serialized `evidence_snapshot` accepted, in UTF-16 code units of its
 * JSON. The web client sends an alt candidate's score and signals (a few KiB);
 * the cap stops the free-form JSONB from being used to bloat the table.
 */
export const EVIDENCE_SNAPSHOT_MAX_JSON_LENGTH = 16_384;

const createBody = z.object({
  other_player_id: z.string().uuid(),
  link_type: z.enum(PLAYER_LINK_TYPES),
  status: z.enum(PLAYER_LINK_STATUSES).default('confirmed'),
  note: z.string().trim().max(2000).optional(),
  evidence_snapshot: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= EVIDENCE_SNAPSHOT_MAX_JSON_LENGTH, {
      message: 'evidence_snapshot_too_large',
    })
    .optional(),
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

/**
 * The audit before/after view of a link. `audit_log` is append-only, so the
 * free-form evidence snapshot is recorded as its SHA-256 (enough to prove
 * which snapshot the row held) instead of being copied in full.
 */
function snapshot(row: PlayerLinkRow) {
  const { evidenceSnapshot, ...rest } = row;
  return {
    ...rest,
    evidenceSnapshotSha256:
      evidenceSnapshot == null
        ? null
        : createHash('sha256').update(JSON.stringify(evidenceSnapshot)).digest('hex'),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function auditMutation(
  db: DatabaseClient | AuditTransaction,
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

  /** One query for every summary a response needs, keyed by player id. */
  async function loadPlayerSummaries(
    ids: ReadonlyArray<string | null>,
  ): Promise<Map<string, PlayerSummaryRow>> {
    const uniqueIds = Array.from(new Set(ids.filter((id): id is string => id != null)));
    if (uniqueIds.length === 0) return new Map();
    const rows = await app.db
      .select({
        id: players.id,
        current_name: players.canonicalName,
        steam_id64: players.steamId64,
      })
      .from(players)
      .where(inArray(players.id, uniqueIds));
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          current_name: row.current_name,
          steam_id64: row.steam_id64?.toString() ?? null,
        },
      ]),
    );
  }

  function createdByOf(
    summaries: Map<string, PlayerSummaryRow>,
    id: string | null,
  ): { player_id: string; name: string } | null {
    const summary = id ? summaries.get(id) : undefined;
    return summary ? { player_id: summary.id, name: summary.current_name } : null;
  }

  fast.post(
    '/api/v1/players/:playerId/links',
    {
      schema: { params: playerIdParams, body: createBody },
      config: { permissions: ['player:view_ips'], audit: 'manual' },
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

      // biome-ignore lint/style/noNonNullAssertion: guaranteed by the player:view_ips permission gate
      const actorId = req.user!.playerId;
      const summaries = await loadPlayerSummaries([playerId, otherPlayerId, actorId]);
      const other = summaries.get(otherPlayerId);
      if (!summaries.has(playerId) || !other) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const [playerAId, playerBId] =
        playerId < otherPlayerId ? [playerId, otherPlayerId] : [otherPlayerId, playerId];

      const inserted = await app.db.transaction(async (tx) => {
        const [row] = await tx
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
        if (!row) return null;
        await auditMutation(tx, req, {
          action: 'player_link.create',
          targetId: row.id,
          before: null,
          after: snapshot(row),
        });
        return row;
      });
      if (!inserted) {
        reply.code(409);
        return { error: 'link_exists' };
      }

      reply.code(201);
      return serializeLink(inserted, other, createdByOf(summaries, inserted.createdBy));
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
        .where(or(eq(playerLinks.playerAId, playerId), eq(playerLinks.playerBId, playerId)))
        .orderBy(desc(playerLinks.updatedAt), desc(playerLinks.id))
        .limit(PLAYER_LINKS_LIMIT + 1);
      const truncated = rows.length > PLAYER_LINKS_LIMIT;
      const page = truncated ? rows.slice(0, PLAYER_LINKS_LIMIT) : rows;

      const otherIdOf = (row: PlayerLinkRow) =>
        row.playerAId === playerId ? row.playerBId : row.playerAId;
      const summaries = await loadPlayerSummaries(
        page.flatMap((row) => [otherIdOf(row), row.createdBy]),
      );

      const links = page.map((row) =>
        serializeLink(
          row,
          summaries.get(otherIdOf(row)) ?? null,
          createdByOf(summaries, row.createdBy),
        ),
      );

      return { links, truncated };
    },
  );

  fast.patch(
    '/api/v1/player-links/:linkId',
    {
      schema: { params: linkIdParams, body: patchBody },
      config: { permissions: ['player:view_ips'], audit: 'manual' },
    },
    async (req, reply) => {
      const { linkId } = req.params;
      const updates: Partial<typeof playerLinks.$inferInsert> = { updatedAt: new Date() };
      if (req.body.link_type !== undefined) updates.linkType = req.body.link_type;
      if (req.body.status !== undefined) updates.status = req.body.status;
      if (req.body.note !== undefined) updates.note = req.body.note;

      // The row lock keeps the audit `before` snapshot exact under concurrent
      // PATCHes, and the audit row commits or rolls back with the update.
      const updated = await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(playerLinks)
          .where(eq(playerLinks.id, linkId))
          .limit(1)
          .for('update');
        if (!existing) return null;
        const [row] = await tx
          .update(playerLinks)
          .set(updates)
          .where(eq(playerLinks.id, linkId))
          .returning();
        if (!row) throw new Error('player_links update returned no row');
        await auditMutation(tx, req, {
          action: 'player_link.update',
          targetId: existing.id,
          before: snapshot(existing),
          after: snapshot(row),
        });
        return row;
      });
      if (!updated) {
        reply.code(404);
        return { error: 'link_not_found' };
      }

      // PATCH has no "viewpoint" player (unlike POST/GET, which are scoped to
      // one side of the pair) — return both sides' summaries explicitly.
      const summaries = await loadPlayerSummaries([
        updated.playerAId,
        updated.playerBId,
        updated.createdBy,
      ]);
      const createdBy = createdByOf(summaries, updated.createdBy);
      const playerA = summaries.get(updated.playerAId) ?? null;
      const playerB = summaries.get(updated.playerBId) ?? null;
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
