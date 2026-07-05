import { auditLog, type DatabaseClient, playerNameHistory, players } from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import { eq, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { RconPlayer } from './parse-list-players.js';

async function writeSystemAudit(
  db: DatabaseClient,
  action: string,
  targetId: string,
  context: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    actorKind: 'system',
    actorSystemLabel: 'rcon-sync',
    actionType: action,
    targetType: 'player',
    targetId,
    context: context as object,
    rowHash: Buffer.from([]),
  });
}

export async function upsertPlayers(db: DatabaseClient, incoming: RconPlayer[]): Promise<void> {
  if (incoming.length === 0) return;
  for (const p of incoming) {
    const normalised = normalizePlayerName(p.name);
    const steamBigint = p.steam_id64 ? BigInt(p.steam_id64) : null;

    const matchClause =
      steamBigint === null
        ? eq(players.eosId, p.eos_id)
        : or(eq(players.eosId, p.eos_id), eq(players.steamId64, steamBigint));

    const existing = await db
      .select({
        id: players.id,
        steamId64: players.steamId64,
        canonicalName: players.canonicalName,
        eosId: players.eosId,
      })
      .from(players)
      .where(matchClause)
      .limit(1);

    if (existing[0]) {
      const row = existing[0];
      const playerId = row.id;

      const updates: Record<string, unknown> = {
        lastSeenAt: new Date(),
        updatedAt: new Date(),
        canonicalName: p.name,
        canonicalNameNormalized: normalised,
      };

      if (!row.eosId && p.eos_id) {
        updates.eosId = p.eos_id;
      }

      if (!row.steamId64 && steamBigint) {
        updates.steamId64 = steamBigint;
        await writeSystemAudit(db, 'player.steam_linked', playerId, {
          steam_id64: p.steam_id64,
          eos_id: p.eos_id,
        });
      }

      await db.update(players).set(updates).where(eq(players.id, playerId));

      await db
        .insert(playerNameHistory)
        .values({ playerId, name: p.name, nameNormalized: normalised })
        .onConflictDoUpdate({
          target: [playerNameHistory.playerId, playerNameHistory.nameNormalized],
          set: {
            lastSeenAt: new Date(),
            observationCount: sql`${playerNameHistory.observationCount} + 1`,
          },
        });
    } else {
      const playerId = uuidv7();
      await db.insert(players).values({
        id: playerId,
        steamId64: steamBigint,
        eosId: p.eos_id,
        canonicalName: p.name,
        canonicalNameNormalized: normalised,
      });

      await db.insert(playerNameHistory).values({
        playerId,
        name: p.name,
        nameNormalized: normalised,
      });

      await writeSystemAudit(db, 'player.created', playerId, {
        steam_id64: p.steam_id64,
        eos_id: p.eos_id,
        canonical_name: p.name,
      });
    }
  }
}
