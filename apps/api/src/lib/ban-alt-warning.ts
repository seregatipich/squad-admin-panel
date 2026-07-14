import { findConfirmedAltLinks } from '@squad/db';
import { playerSessions, players } from '@squad/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

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

interface CandidateResponse {
  candidates?: Array<{
    player_id: string;
    current_name: string | null;
    confidence: string;
    link: { status: string } | null;
  }>;
}

interface BanStatusRow {
  player_id: string;
  has_active_ban: boolean;
}

/**
 * Loads the data needed by ALT-7 without exposing IPs. Candidate details are
 * obtained from the existing ALT-1 route, so its scoring and settings remain
 * the single source of truth. Viewers without `player:view_ips` receive only
 * the confirmed-link count needed for the privacy-degraded warning.
 */
export async function loadBanAltWarning(
  app: FastifyInstance,
  input: {
    playerId: string;
    canViewIps: boolean;
    cookie?: string;
    authorization?: string;
  },
): Promise<BanAltWarning | null> {
  const [target] = await app.db
    .select({ id: players.id })
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

  const headers: Record<string, string> = {};
  if (input.cookie) headers.cookie = input.cookie;
  if (input.authorization) headers.authorization = input.authorization;
  const candidateResponse = await app.inject({
    method: 'GET',
    url: `/api/v1/players/${input.playerId}/alt-candidates?limit=100`,
    headers,
  });
  const candidateBody =
    candidateResponse.statusCode === 200
      ? (JSON.parse(candidateResponse.body) as CandidateResponse)
      : { candidates: [] };
  const candidates = (candidateBody.candidates ?? []).filter(
    (candidate) => candidate.confidence === 'high' && candidate.link?.status !== 'confirmed',
  );
  const candidateIds = candidates.map((candidate) => candidate.player_id);
  const allIds = Array.from(new Set([...confirmedIds, ...candidateIds]));
  const statusById = new Map<string, boolean>();
  const onlineIds = new Set<string>();

  if (allIds.length > 0) {
    const statusRows = (await app.db.execute(sql`
      SELECT
        p.id AS player_id,
        (
          EXISTS (
            SELECT 1 FROM moderation_actions ma
            WHERE ma.player_id = p.id
              AND ma.action_type LIKE '%ban%'
              AND ma.action_type NOT LIKE 'ban_source%'
              AND ma.reverted_at IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM external_bans eb
            WHERE eb.steam_id64 = p.steam_id64::text
              AND eb.revoked_at IS NULL
              AND (eb.expires_at IS NULL OR eb.expires_at > now())
          )
        ) AS has_active_ban
      FROM players p
      WHERE p.id IN (${sql.join(
        allIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `)) as unknown as BanStatusRow[];
    for (const row of statusRows) statusById.set(row.player_id, row.has_active_ban);

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
