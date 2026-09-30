import { type DatabaseClient, events, matchPlayers } from '@squad/db';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';

/** Event kinds that contribute to per-player totals. */
export const COMBAT_COUNTED_KINDS: string[] = ['combat_death', 'combat_wound', 'combat_revive'];

/**
 * Per-hit damage events are the most numerous combat events and are not
 * counted; their presence alone marks the match as combat-tracked.
 */
const COMBAT_DAMAGE_KIND = 'combat_damage';

export interface PlayerCombatStats {
  kills: number;
  deaths: number;
  teamkills: number;
  wounds: number;
  revives: number;
}

export interface MatchCombatStats {
  present: boolean;
  byPlayer: Map<string, PlayerCombatStats>;
}

export interface CombatEventRow {
  kind: string;
  payload: Record<string, unknown>;
}

const ZERO: PlayerCombatStats = { kills: 0, deaths: 0, teamkills: 0, wounds: 0, revives: 0 };

function readId(payload: Record<string, unknown>, key: string): string | null {
  const raw = payload[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function bucket(byPlayer: Map<string, PlayerCombatStats>, playerId: string): PlayerCombatStats {
  const existing = byPlayer.get(playerId);
  if (existing) return existing;
  const fresh = { ...ZERO };
  byPlayer.set(playerId, fresh);
  return fresh;
}

export function aggregateCombatStats(rows: CombatEventRow[]): MatchCombatStats {
  const byPlayer = new Map<string, PlayerCombatStats>();

  for (const row of rows) {
    const payload = row.payload ?? {};
    const isTeamkill = payload.is_teamkill === true;
    const isSuicide = payload.is_suicide === true;

    if (row.kind === 'combat_death') {
      const victimId = readId(payload, 'victim_player_id');
      if (victimId) bucket(byPlayer, victimId).deaths += 1;

      const attackerId = readId(payload, 'attacker_player_id');
      if (attackerId) {
        if (isTeamkill) bucket(byPlayer, attackerId).teamkills += 1;
        else if (!isSuicide) bucket(byPlayer, attackerId).kills += 1;
      }
      continue;
    }

    if (row.kind === 'combat_wound') {
      const attackerId = readId(payload, 'attacker_player_id');
      if (attackerId && !isTeamkill && !isSuicide) bucket(byPlayer, attackerId).wounds += 1;
      continue;
    }

    if (row.kind === 'combat_revive') {
      const medicId = readId(payload, 'medic_player_id');
      if (medicId) bucket(byPlayer, medicId).revives += 1;
    }
  }

  return { present: rows.length > 0, byPlayer };
}

export async function loadMatchCombatStats(
  db: DatabaseClient,
  params: { serverId: string; matchStart: Date; matchEnd: Date },
): Promise<MatchCombatStats> {
  const inMatchWindow = and(
    eq(events.serverId, params.serverId),
    gte(events.occurredAt, params.matchStart),
    lte(events.occurredAt, params.matchEnd),
  );

  const rows = await db
    .select({ kind: events.kind, payload: events.payload })
    .from(events)
    .where(and(inMatchWindow, inArray(events.kind, COMBAT_COUNTED_KINDS)));
  const stats = aggregateCombatStats(
    rows.map((row) => ({ kind: row.kind, payload: row.payload as Record<string, unknown> })),
  );
  if (stats.present) return stats;

  const damageRows = await db
    .select({ eventId: events.eventId })
    .from(events)
    .where(and(inMatchWindow, eq(events.kind, COMBAT_DAMAGE_KIND)))
    .limit(1);
  return { present: damageRows.length > 0, byPlayer: stats.byPlayer };
}

export async function applyMatchCombatStats(
  db: DatabaseClient,
  params: {
    matchId: string;
    playerIds: string[];
    stats: MatchCombatStats;
  },
): Promise<void> {
  if (params.playerIds.length === 0) return;

  const rows = params.playerIds.map((playerId) => {
    const value = params.stats.present ? (params.stats.byPlayer.get(playerId) ?? ZERO) : null;
    return sql`(${playerId}::uuid, ${value ? value.kills : null}::int, ${value ? value.deaths : null}::int, ${value ? value.teamkills : null}::int, ${value ? value.wounds : null}::int, ${value ? value.revives : null}::int)`;
  });

  await db.execute(sql`
    UPDATE ${matchPlayers} AS mp
    SET kills = v.kills,
        deaths = v.deaths,
        teamkills = v.teamkills,
        wounds = v.wounds,
        revives = v.revives
    FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(player_id, kills, deaths, teamkills, wounds, revives)
    WHERE mp.match_id = ${params.matchId}::uuid AND mp.player_id = v.player_id
  `);
}
