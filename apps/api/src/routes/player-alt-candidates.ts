import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { computeAltCandidates } from '../lib/alt-candidates.js';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * ALT-1 candidate engine. Serves the shared-IP-based "possible alt accounts"
 * list for a player: everyone who has ever logged in from an IP the target
 * also used, scored by a set of tunable heuristics on top of the raw
 * shared-IP signal (shared historical nicknames, a "young" account created
 * after the target's last ban, and SteamID64 proximity suggesting batch
 * registration), minus the ALT-3 co-play anti-signal: a pair whose rolling
 * `player_coplay.overlap_seconds` (see `@squad/db` `COPLAY_WINDOW_DAYS`) meets
 * the configured threshold looks more like friends than an alt/twink pair, so
 * it subtracts `weight_coplay_overlap` from the score. Gated on the fine
 * `player:view_ips` permission — without it the endpoint returns 403 and
 * leaks no IPs or candidates at all.
 *
 * Ban convention (no dedicated "ban" moderation_actions type exists yet):
 * `has_active_ban` is true when the candidate has either a non-reverted
 * `moderation_actions` row whose `action_type` contains `ban` (excluding the
 * `ban_source.*` audit trail of the external-ban importer) or an
 * `external_bans` row that isn't revoked and isn't expired; `has_permanent_ban`
 * narrows that further to rows with no expiry (`context->>'expires_at'` /
 * `external_bans.expires_at` both absent).
 *
 * ALT-2 (issue #120) annotation: each candidate also carries `link`, the
 * durable admin verdict for that pair from `player_links` (`{id, link_type,
 * status, note, decided_by_name, decided_at}` or `null` if undecided).
 * Rejected pairs are deliberately NOT filtered out here — the full ALT-1
 * output always includes them, marked, so a caller can tell "no candidate"
 * apart from "considered and rejected". Filtering rejected pairs out of a
 * "possible alts" view is the web layer's job (ALT-6).
 */
const playerAltCandidatesRoutes: FastifyPluginAsync = async (app) => {
  const fast = app.withTypeProvider<ZodTypeProvider>();

  fast.get(
    '/api/v1/players/:playerId/alt-candidates',
    {
      schema: { params: playerIdParams, querystring: listQuery },
      config: { permissions: ['player:view_ips'], audit: false },
    },
    async (req, reply) => {
      const { playerId } = req.params;
      const { limit, offset } = req.query;

      const [target] = await app.db
        .select({
          id: players.id,
          steamId64: players.steamId64,
        })
        .from(players)
        .where(eq(players.id, playerId))
        .limit(1);
      if (!target) {
        reply.code(404);
        return { error: 'player_not_found' };
      }

      const candidates = await computeAltCandidates(app.db, target);

      return {
        candidates: candidates.slice(offset, offset + limit),
        total: candidates.length,
        limit,
        offset,
      };
    },
  );
};

export default playerAltCandidatesRoutes;
