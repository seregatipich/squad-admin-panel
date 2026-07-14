import { altDetectionSettings, players } from '@squad/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  type AltConfidence,
  computeAltScore,
  confidenceFor,
  DEFAULT_ALT_SCORE_WEIGHTS,
} from '../lib/alt-score.js';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;
/** Caps `matches[]` per candidate (smallest time-delta first) to bound response size for CGNAT-heavy targets. */
const MATCHES_PER_CANDIDATE_CAP = 20;

const playerIdParams = z.object({ playerId: z.string().uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

interface MatchAggRow {
  candidate_id: string;
  shared_ip_count: string | number;
  ignored_shared_ip_count: string | number;
  min_time_delta_seconds: string | number | null;
  matches: unknown;
}

interface SharedNameRow {
  candidate_id: string;
  shared_names: string[] | null;
}

interface CandidateInfoRow {
  candidate_id: string;
  current_name: string;
  steam_id64: string | null;
  created_at: Date | string;
  has_active_mod_ban: boolean;
  has_permanent_mod_ban: boolean;
  has_active_external_ban: boolean;
  has_permanent_external_ban: boolean;
}

interface CandidateMatch {
  ip: string;
  geo: { country_code: string | null; country_name: string | null; city: string | null };
  owner_seen_at: string;
  candidate_seen_at: string;
  ignored: boolean;
}

/**
 * ALT-1 candidate engine. Serves the shared-IP-based "possible alt accounts"
 * list for a player: everyone who has ever logged in from an IP the target
 * also used, scored by a set of tunable heuristics on top of the raw
 * shared-IP signal (shared historical nicknames, a "young" account created
 * after the target's last ban, and SteamID64 proximity suggesting batch
 * registration). Gated on the fine `player:view_ips` permission — without it
 * the endpoint returns 403 and leaks no IPs or candidates at all.
 *
 * Ban convention (no dedicated "ban" moderation_actions type exists yet):
 * `has_active_ban` is true when the candidate has either a non-reverted
 * `moderation_actions` row whose `action_type` contains `ban` (excluding the
 * `ban_source.*` audit trail of the external-ban importer) or an
 * `external_bans` row that isn't revoked and isn't expired; `has_permanent_ban`
 * narrows that further to rows with no expiry (`context->>'expires_at'` /
 * `external_bans.expires_at` both absent).
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

      const [settingsRow] = await app.db
        .select()
        .from(altDetectionSettings)
        .where(eq(altDetectionSettings.id, 1))
        .limit(1);
      const weights = settingsRow
        ? {
            weightSharedIp: settingsRow.weightSharedIp,
            weightSharedName: settingsRow.weightSharedName,
            weightYoungAccount: settingsRow.weightYoungAccount,
            weightSteamidProximity: settingsRow.weightSteamidProximity,
          }
        : DEFAULT_ALT_SCORE_WEIGHTS;
      const steamidDeltaThreshold = BigInt(settingsRow?.steamidDeltaThreshold ?? 10_000);
      const thresholds = {
        mediumThreshold: settingsRow?.mediumThreshold ?? 50,
        highThreshold: settingsRow?.highThreshold ?? 75,
      };

      const matchRows = (await app.db.execute(sql`
        WITH matches AS (
          SELECT
            b.player_id AS candidate_id,
            a.ip AS ip,
            a.country_code,
            a.country_name,
            a.city,
            a.last_seen_at AS owner_seen_at,
            b.last_seen_at AS candidate_seen_at,
            EXISTS (
              SELECT 1 FROM alt_ignored_ips i WHERE a.ip <<= i.cidr
            ) AS ignored,
            ABS(EXTRACT(EPOCH FROM (a.last_seen_at - b.last_seen_at))) AS delta_seconds
          FROM player_ip_history a
          JOIN player_ip_history b ON b.ip = a.ip AND b.player_id <> a.player_id
          WHERE a.player_id = ${playerId}
        ),
        ranked AS (
          SELECT *, row_number() OVER (PARTITION BY candidate_id ORDER BY delta_seconds ASC) AS rn
          FROM matches
        )
        SELECT
          candidate_id,
          COUNT(*) FILTER (WHERE NOT ignored) AS shared_ip_count,
          COUNT(*) FILTER (WHERE ignored) AS ignored_shared_ip_count,
          MIN(delta_seconds) FILTER (WHERE NOT ignored) AS min_time_delta_seconds,
          json_agg(
            json_build_object(
              'ip', host(ip),
              'geo', json_build_object(
                'country_code', country_code,
                'country_name', country_name,
                'city', city
              ),
              'owner_seen_at', owner_seen_at,
              'candidate_seen_at', candidate_seen_at,
              'ignored', ignored
            ) ORDER BY delta_seconds ASC
          ) FILTER (WHERE rn <= ${MATCHES_PER_CANDIDATE_CAP}) AS matches
        FROM ranked
        GROUP BY candidate_id
      `)) as unknown as MatchAggRow[];

      if (matchRows.length === 0) {
        return { candidates: [], total: 0, limit, offset };
      }

      const candidateIds = matchRows.map((row) => row.candidate_id);
      const candidateIdList = sql.join(
        candidateIds.map((id) => sql`${id}`),
        sql`, `,
      );

      const nameRows = (await app.db.execute(sql`
        SELECT
          h2.player_id AS candidate_id,
          array_agg(DISTINCT h1.name_normalized) AS shared_names
        FROM player_name_history h1
        JOIN player_name_history h2
          ON h2.name_normalized = h1.name_normalized AND h2.player_id <> h1.player_id
        WHERE h1.player_id = ${playerId} AND h2.player_id IN (${candidateIdList})
        GROUP BY h2.player_id
      `)) as unknown as SharedNameRow[];
      const sharedNamesByCandidate = new Map(
        nameRows.map((row) => [row.candidate_id, row.shared_names ?? []]),
      );

      const [lastBanRow] = (await app.db.execute(sql`
        SELECT MAX(created_at) AS last_ban_at
        FROM moderation_actions
        WHERE player_id = ${playerId}
          AND action_type LIKE '%ban%'
          AND action_type NOT LIKE 'ban_source%'
      `)) as unknown as Array<{ last_ban_at: Date | string | null }>;
      const lastBanAt = lastBanRow?.last_ban_at ? new Date(lastBanRow.last_ban_at) : null;

      const infoRows = (await app.db.execute(sql`
        SELECT
          p.id AS candidate_id,
          p.canonical_name AS current_name,
          p.steam_id64::text AS steam_id64,
          p.created_at,
          EXISTS (
            SELECT 1 FROM moderation_actions ma
            WHERE ma.player_id = p.id AND ma.action_type LIKE '%ban%'
              AND ma.action_type NOT LIKE 'ban_source%' AND ma.reverted_at IS NULL
          ) AS has_active_mod_ban,
          EXISTS (
            SELECT 1 FROM moderation_actions ma
            WHERE ma.player_id = p.id AND ma.action_type LIKE '%ban%'
              AND ma.action_type NOT LIKE 'ban_source%' AND ma.reverted_at IS NULL
              AND (ma.context ->> 'expires_at') IS NULL
          ) AS has_permanent_mod_ban,
          EXISTS (
            SELECT 1 FROM external_bans eb
            WHERE eb.steam_id64 = p.steam_id64::text AND eb.revoked_at IS NULL
              AND (eb.expires_at IS NULL OR eb.expires_at > now())
          ) AS has_active_external_ban,
          EXISTS (
            SELECT 1 FROM external_bans eb
            WHERE eb.steam_id64 = p.steam_id64::text AND eb.revoked_at IS NULL
              AND eb.expires_at IS NULL
          ) AS has_permanent_external_ban
        FROM players p
        WHERE p.id IN (${candidateIdList})
      `)) as unknown as CandidateInfoRow[];
      const infoByCandidate = new Map(infoRows.map((row) => [row.candidate_id, row]));

      const candidates = matchRows
        .map((row) => {
          const info = infoByCandidate.get(row.candidate_id);
          const sharedNames = sharedNamesByCandidate.get(row.candidate_id) ?? [];
          const sharedIpCount = Number(row.shared_ip_count);
          const candidateSteamId64 = info?.steam_id64 != null ? BigInt(info.steam_id64) : null;
          const steamidClose =
            target.steamId64 != null &&
            candidateSteamId64 != null &&
            (target.steamId64 > candidateSteamId64
              ? target.steamId64 - candidateSteamId64
              : candidateSteamId64 - target.steamId64) < steamidDeltaThreshold;
          const youngAccount =
            lastBanAt != null && info != null && new Date(info.created_at) > lastBanAt;

          const score = computeAltScore(
            {
              sharedIpCount,
              sharedNameCount: sharedNames.length,
              youngAccount,
              steamidClose,
            },
            weights,
          );
          const confidence: AltConfidence = confidenceFor(score, thresholds);

          return {
            player_id: row.candidate_id,
            current_name: info?.current_name ?? null,
            steam_id64: candidateSteamId64 != null ? candidateSteamId64.toString() : null,
            shared_ip_count: sharedIpCount,
            ignored_shared_ip_count: Number(row.ignored_shared_ip_count),
            min_time_delta_seconds:
              row.min_time_delta_seconds != null ? Number(row.min_time_delta_seconds) : null,
            matches: (row.matches as CandidateMatch[] | null) ?? [],
            signals: {
              shared_ips: { value: sharedIpCount, weight: weights.weightSharedIp },
              shared_names: { value: sharedNames, weight: weights.weightSharedName },
              young_account: { value: youngAccount, weight: weights.weightYoungAccount },
              steamid_proximity: { value: steamidClose, weight: weights.weightSteamidProximity },
            },
            score,
            confidence,
            has_active_ban: Boolean(info?.has_active_mod_ban || info?.has_active_external_ban),
            has_permanent_ban: Boolean(
              info?.has_permanent_mod_ban || info?.has_permanent_external_ban,
            ),
          };
        })
        .sort((a, b) => b.score - a.score || a.player_id.localeCompare(b.player_id));

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
