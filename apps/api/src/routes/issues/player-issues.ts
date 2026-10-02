import { issueLinks, issues } from '@squad/db/schema';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { playerIdParam } from '../../lib/issues/schemas.js';
import { panelGuard } from '../../lib/panel-guard.js';

const PLAYER_CARD_ISSUES_LIMIT = 50;

/** Tickets that link to one player, for the player card. */
const playerIssueRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Reverse lookup for the player card: the tickets still awaiting work that
   * name this player. `open_count` counts every ticket not yet `closed`;
   * `items` carries the newest {@link PLAYER_CARD_ISSUES_LIMIT} of them.
   */
  fast.get(
    '/api/v1/players/:playerId/issues',
    { schema: { params: playerIdParam }, config: { permissions: ['issue:view'] } },
    async (req, reply) => {
      const denied = panelGuard(req, reply);
      if (denied) return denied;

      const openForPlayer = and(
        eq(issueLinks.entityType, 'player'),
        eq(issueLinks.entityId, req.params.playerId),
        ne(issues.state, 'closed'),
      );
      const rows = await app.db
        .select({
          id: issues.id,
          number: issues.number,
          title: issues.title,
          state: issues.state,
          createdAt: issues.createdAt,
        })
        .from(issueLinks)
        .innerJoin(issues, eq(issues.id, issueLinks.issueId))
        .where(openForPlayer)
        .orderBy(desc(issues.number))
        .limit(PLAYER_CARD_ISSUES_LIMIT);
      const openCount =
        rows.length < PLAYER_CARD_ISSUES_LIMIT
          ? rows.length
          : ((
              await app.db
                .select({ count: sql<number>`count(*)::int` })
                .from(issueLinks)
                .innerJoin(issues, eq(issues.id, issueLinks.issueId))
                .where(openForPlayer)
            )[0]?.count ?? rows.length);

      return {
        open_count: openCount,
        items: rows.map((row) => ({
          id: row.id,
          number: Number(row.number),
          title: row.title,
          state: row.state,
          created_at: row.createdAt.toISOString(),
        })),
      };
    },
  );
};

export default playerIssueRoutes;
