import { findConfirmedAltLinks } from '@squad/db';
import { playerSessions, players } from '@squad/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { computeAltCandidates } from './alt-candidates.js';
import { loadModerationBanStates } from './moderation-ban-state.js';
import { uuidArrayParam } from './sql-params.js';

export interface BanAltWarningItem {
  player_id: string;
  name: string;
  link_type?: string;
  status?: string;
  confidence?: 'high';
  online: boolean;
  has_active_ban: boolean;
}

export interface BanAltWarning {
  can_view_ips: boolean;
  confirmed_count: number;
  candidate_count: number;
  confirmed: BanAltWarningItem[];
  candidates: BanAltWarningItem[];
}

interface BanStatusRow {
  player_id: string;
  has_active_ban: boolean;
}

/** How many top-scored ALT-1 candidates the warning considers. */
const CANDIDATE_SCAN_LIMIT = 100;

/**
 * Loads the data needed by ALT-7 without exposing IPs. Candidates come from
 * {@link computeAltCandidates}, the same scoring the ALT-1 route serves, so
 * its settings remain the single source of truth; a failure there throws
 * instead of silently reading as "no candidates". Viewers without
 * `player:view_ips` receive only the confirmed-link count needed for the
 * privacy-degraded warning.
 *
 * @returns The warning, or null when the player does not exist.
 */
export async function loadBanAltWarning(
  app: FastifyInstance,
  input: {
    playerId: string;
    canViewIps: boolean;
  },
): Promise<BanAltWarning | null> {
  const [target] = await app.db
    .select({ id: players.id, steamId64: players.steamId64 })
    .from(players)
    .where(eq(players.id, input.playerId))
    .limit(1);
  if (!target) return null;

  const links = await findConfirmedAltLinks(app.db, input.playerId);
  const confirmedIds = links.map((link) => link.linkedPlayerId);

  if (!input.canViewIps) {
    return {
      can_view_ips: false,
      confirmed_count: confirmedIds.length,
      candidate_count: 0,
      confirmed: [],
      candidates: [],
    };
  }

  const scored = (await computeAltCandidates(app.db, target)).slice(0, CANDIDATE_SCAN_LIMIT);
  const candidates = scored.filter(
    (candidate) => candidate.confidence === 'high' && candidate.link?.status !== 'confirmed',
  );
  const candidateIds = candidates.map((candidate) => candidate.player_id);
  const allIds = Array.from(new Set([...confirmedIds, ...candidateIds]));
  const statusById = new Map<string, boolean>();
  const onlineIds = new Set<string>();

  if (allIds.length > 0) {
    const externalRows = (await app.db.execute(sql`
      SELECT
        p.id AS player_id,
        EXISTS (
          SELECT 1 FROM external_bans eb
          WHERE eb.steam_id64 = p.steam_id64::text
            AND eb.revoked_at IS NULL
            AND (eb.expires_at IS NULL OR eb.expires_at > now())
        ) AS has_active_ban
      FROM players p
      WHERE p.id = ANY(${uuidArrayParam(allIds)})
    `)) as unknown as BanStatusRow[];
    const modBans = await loadModerationBanStates(app.db, allIds);
    for (const row of externalRows) {
      statusById.set(row.player_id, row.has_active_ban || modBans.has(row.player_id));
    }

    const onlineRows = await app.db
      .select({ playerId: playerSessions.playerId })
      .from(playerSessions)
      .where(and(inArray(playerSessions.playerId, allIds), isNull(playerSessions.disconnectedAt)));
    for (const row of onlineRows) onlineIds.add(row.playerId);
  }

  const summaries = allIds.length
    ? await app.db
        .select({ id: players.id, name: players.canonicalName })
        .from(players)
        .where(inArray(players.id, allIds))
    : [];
  const nameById = new Map(summaries.map((row) => [row.id, row.name]));

  const confirmed = links.map((link) => {
    const id = link.linkedPlayerId;
    return {
      player_id: id,
      name: nameById.get(id) ?? '—',
      link_type: link.linkType,
      status: link.status,
      online: onlineIds.has(id),
      has_active_ban: statusById.get(id) ?? false,
    } satisfies BanAltWarningItem;
  });
  const candidateItems = candidates
    .filter((candidate) => nameById.has(candidate.player_id))
    .map((candidate) => ({
      player_id: candidate.player_id,
      name: nameById.get(candidate.player_id) ?? candidate.current_name ?? '—',
      confidence: 'high' as const,
      online: onlineIds.has(candidate.player_id),
      has_active_ban: statusById.get(candidate.player_id) ?? false,
    }));

  return {
    can_view_ips: true,
    confirmed_count: confirmed.length,
    candidate_count: candidateItems.length,
    confirmed,
    candidates: candidateItems,
  };
}
