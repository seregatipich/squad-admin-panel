import { clanMembers, matches, matchPlayers, players, servers } from '@squad/db/schema';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { clanAccess } from '../../lib/clans/access.js';
import { clanIdParams } from '../../lib/clans/common.js';
import { requestUser } from '../../lib/request-user.js';

const MATCHES_LIMIT_DEFAULT = 20;
const MATCHES_LIMIT_MAX = 100;

const matchesQuery = z.object({
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(MATCHES_LIMIT_MAX).default(MATCHES_LIMIT_DEFAULT),
  server_id: z.string().uuid().optional(),
});

/**
 * Keyset cursor of the clan matches feed: `v` is the page boundary's
 * `started_at` in epoch ms, bounded to the range `Date` can represent so an
 * absurd value is an `invalid_cursor` rather than an Invalid Date that fails
 * serialisation with a 500 (#132).
 */
const matchesCursorSchema = z.object({
  v: z.number().int().min(0).max(8.64e15),
  id: z.string().uuid(),
});
type MatchesCursor = z.infer<typeof matchesCursorSchema>;

function encodeMatchesCursor(cursor: MatchesCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function parseMatchesCursor(raw: string): MatchesCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
    const parsed = matchesCursorSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Keyset-paginated match feed of a clan. */
const clanMatchesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();
  const { loadActiveClan } = clanAccess(app);

  fast.get(
    '/api/v1/clans/:id/matches',
    { schema: { params: clanIdParams, querystring: matchesQuery }, config: { audit: false } },
    async (req, reply) => {
      const user = requestUser(req);
      if (!user.permissions.panelAccess) {
        reply.code(403);
        return { error: 'forbidden' };
      }
      const clan = await loadActiveClan(req.params.id);
      if (!clan) {
        reply.code(404);
        return { error: 'clan_not_found' };
      }

      const { limit, server_id: serverId } = req.query;
      const participationExists = sql`EXISTS (
        SELECT 1 FROM ${matchPlayers} mp
        JOIN ${clanMembers} cm ON cm.player_id = mp.player_id
        WHERE mp.match_id = ${matches.id} AND cm.clan_id = ${clan.id}
      )`;

      const clauses = [participationExists];
      if (serverId) clauses.push(eq(matches.serverId, serverId));

      if (req.query.cursor) {
        const cursor = parseMatchesCursor(req.query.cursor);
        if (!cursor) {
          reply.code(400);
          return { error: 'invalid_cursor' };
        }
        const startedAt = new Date(cursor.v);
        const keyset = or(
          lt(matches.startedAt, startedAt),
          and(eq(matches.startedAt, startedAt), lt(matches.id, cursor.id)),
        );
        if (keyset) clauses.push(keyset);
      }

      const rows = await app.db
        .select({
          id: matches.id,
          serverId: matches.serverId,
          serverName: servers.displayName,
          serverSlug: servers.slug,
          layer: matches.layer,
          map: matches.map,
          team1Faction: matches.team1Faction,
          team2Faction: matches.team2Faction,
          team1Tickets: matches.team1Tickets,
          team2Tickets: matches.team2Tickets,
          winner: matches.winner,
          isSeed: matches.isSeed,
          startedAt: matches.startedAt,
          endedAt: matches.endedAt,
          durationSeconds: matches.durationSeconds,
        })
        .from(matches)
        .leftJoin(servers, eq(servers.id, matches.serverId))
        .where(and(...clauses))
        .orderBy(desc(matches.startedAt), desc(matches.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      const nextCursor =
        hasMore && last ? encodeMatchesCursor({ v: last.startedAt.getTime(), id: last.id }) : null;

      const participantsByMatch = new Map<
        string,
        Array<{ player_id: string; name: string; member_role: string }>
      >();
      if (page.length > 0) {
        const participantRows = await app.db
          .select({
            matchId: matchPlayers.matchId,
            playerId: players.id,
            canonicalName: players.canonicalName,
            memberRole: clanMembers.memberRole,
          })
          .from(matchPlayers)
          .innerJoin(
            clanMembers,
            and(eq(clanMembers.playerId, matchPlayers.playerId), eq(clanMembers.clanId, clan.id)),
          )
          .innerJoin(players, eq(players.id, matchPlayers.playerId))
          .where(
            inArray(
              matchPlayers.matchId,
              page.map((row) => row.id),
            ),
          )
          .orderBy(asc(players.canonicalName));
        for (const participant of participantRows) {
          let group = participantsByMatch.get(participant.matchId);
          if (!group) {
            group = [];
            participantsByMatch.set(participant.matchId, group);
          }
          group.push({
            player_id: participant.playerId,
            name: participant.canonicalName,
            member_role: participant.memberRole,
          });
        }
      }

      return {
        clan_id: clan.id,
        items: page.map((row) => {
          const participants = participantsByMatch.get(row.id) ?? [];
          return {
            id: row.id,
            server_id: row.serverId,
            server_name: row.serverName,
            server_slug: row.serverSlug,
            layer: row.layer,
            map: row.map,
            team1_faction: row.team1Faction,
            team2_faction: row.team2Faction,
            team1_tickets: row.team1Tickets,
            team2_tickets: row.team2Tickets,
            winner: row.winner,
            is_seed: row.isSeed,
            started_at: row.startedAt.toISOString(),
            ended_at: row.endedAt ? row.endedAt.toISOString() : null,
            duration_seconds: row.durationSeconds,
            clan_participants_count: participants.length,
            participants,
          };
        }),
        next_cursor: nextCursor,
        limit,
      };
    },
  );
};

export default clanMatchesRoutes;
