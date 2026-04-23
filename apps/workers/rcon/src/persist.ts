import { type DatabaseClient, playerNameHistory, players } from '@squad/db';
import { sql } from 'drizzle-orm';
import type { RconPlayer } from './parse-list-players.js';

/** Case-insensitive, whitespace-collapsed normalisation. */
function normalise(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function upsertPlayers(db: DatabaseClient, incoming: RconPlayer[]): Promise<void> {
  if (incoming.length === 0) return;
  for (const p of incoming) {
    const normalised = normalise(p.name);
    const steamBigint = BigInt(p.steam_id64);
    await db
      .insert(players)
      .values({
        steamId64: steamBigint,
        canonicalName: p.name,
        canonicalNameNormalized: normalised,
        eosId: p.eos_id,
      })
      .onConflictDoUpdate({
        target: players.steamId64,
        set: {
          lastSeenAt: new Date(),
          canonicalName: p.name,
          canonicalNameNormalized: normalised,
          eosId: sql`coalesce(excluded.eos_id, ${players.eosId})`,
          updatedAt: new Date(),
        },
      });

    await db
      .insert(playerNameHistory)
      .values({
        steamId64: steamBigint,
        name: p.name,
        nameNormalized: normalised,
      })
      .onConflictDoUpdate({
        target: [playerNameHistory.steamId64, playerNameHistory.nameNormalized],
        set: {
          lastSeenAt: new Date(),
          observationCount: sql`${playerNameHistory.observationCount} + 1`,
        },
      });
  }
}
