import { type DatabaseClient, matches } from '@squad/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  deriveGameMode,
  deriveIsSeed,
  deriveMap,
  type MatchCommand,
  type MatchWinner,
} from '../parser/match.js';

export const DEFAULT_SEED_ONLINE_THRESHOLD = 20;

const rconStatusKey = (serverId: string) => `rcon:status:${serverId}`;

export interface MatchRedis {
  get(key: string): Promise<string | null>;
}

export interface OpenMatchParams {
  serverId: string;
  startedAt: string;
  layer: string | null;
  onlineCount: number | null;
  seedThreshold: number;
}

export async function openMatch(
  db: DatabaseClient,
  params: OpenMatchParams,
): Promise<{ matchId: string | null; inserted: boolean }> {
  const gameMode = deriveGameMode(params.layer);
  const map = deriveMap(params.layer);
  const isSeed = deriveIsSeed({
    gameMode,
    onlineCount: params.onlineCount,
    seedThreshold: params.seedThreshold,
  });

  const rows = await db
    .insert(matches)
    .values({
      id: uuidv7(),
      serverId: params.serverId,
      layer: params.layer,
      map,
      gameMode,
      isSeed,
      startedAt: new Date(params.startedAt),
    })
    .onConflictDoNothing({ target: [matches.serverId, matches.startedAt] })
    .returning({ id: matches.id });

  return { matchId: rows[0]?.id ?? null, inserted: rows.length > 0 };
}

export interface CloseMatchParams {
  serverId: string;
  startedAt: string;
  endedAt: string;
  team1Faction: string | null;
  team2Faction: string | null;
  team1Tickets: number | null;
  team2Tickets: number | null;
  winner: MatchWinner | null;
}

export async function closeMatch(
  db: DatabaseClient,
  params: CloseMatchParams,
): Promise<{ closed: boolean }> {
  const startedAt = new Date(params.startedAt);
  const endedAt = new Date(params.endedAt);
  const durationSeconds = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);

  const rows = await db
    .update(matches)
    .set({
      endedAt,
      team1Faction: params.team1Faction,
      team2Faction: params.team2Faction,
      team1Tickets: params.team1Tickets,
      team2Tickets: params.team2Tickets,
      winner: params.winner,
      endReason: 'ended',
      durationSeconds,
    })
    .where(
      and(
        eq(matches.serverId, params.serverId),
        eq(matches.startedAt, startedAt),
        isNull(matches.endedAt),
      ),
    )
    .returning({ id: matches.id });

  return { closed: rows.length > 0 };
}

export interface CloseServerDownParams {
  serverId: string;
  startedAt: string | null;
  endedAt: string;
  endReason: 'server_crashed' | 'server_restarted';
}

export async function closeServerDown(
  db: DatabaseClient,
  params: CloseServerDownParams,
): Promise<{ closed: boolean }> {
  const endedAt = new Date(params.endedAt);

  if (params.startedAt) {
    const startedAt = new Date(params.startedAt);
    const durationSeconds = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);
    const rows = await db
      .update(matches)
      .set({ endedAt, winner: null, endReason: params.endReason, durationSeconds })
      .where(
        and(
          eq(matches.serverId, params.serverId),
          eq(matches.startedAt, startedAt),
          isNull(matches.endedAt),
        ),
      )
      .returning({ id: matches.id });
    return { closed: rows.length > 0 };
  }

  const rows = await db
    .update(matches)
    .set({
      endedAt,
      winner: null,
      endReason: params.endReason,
      durationSeconds: sql`floor(extract(epoch from (${endedAt.toISOString()}::timestamptz - ${matches.startedAt})))::int`,
    })
    .where(and(eq(matches.serverId, params.serverId), isNull(matches.endedAt)))
    .returning({ id: matches.id });
  return { closed: rows.length > 0 };
}

export function parseOnlineCount(statusValue: string | null): number | null {
  if (!statusValue) return null;
  try {
    const doc = JSON.parse(statusValue) as Record<string, unknown>;
    return typeof doc.player_count === 'number' ? doc.player_count : null;
  } catch {
    return null;
  }
}

export async function handleMatchCommand(
  db: DatabaseClient,
  redis: MatchRedis | null,
  command: MatchCommand,
  options: { seedThreshold: number },
): Promise<void> {
  if (command.kind === 'open') {
    const statusValue = redis ? await redis.get(rconStatusKey(command.serverId)) : null;
    await openMatch(db, {
      serverId: command.serverId,
      startedAt: command.startedAt,
      layer: command.layer,
      onlineCount: parseOnlineCount(statusValue),
      seedThreshold: options.seedThreshold,
    });
    return;
  }

  if (command.kind === 'close') {
    await closeMatch(db, {
      serverId: command.serverId,
      startedAt: command.startedAt,
      endedAt: command.endedAt,
      team1Faction: command.team1Faction,
      team2Faction: command.team2Faction,
      team1Tickets: command.team1Tickets,
      team2Tickets: command.team2Tickets,
      winner: command.winner,
    });
    return;
  }

  await closeServerDown(db, {
    serverId: command.serverId,
    startedAt: command.startedAt,
    endedAt: command.endedAt,
    endReason: command.endReason,
  });
}
