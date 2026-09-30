import { auditLog, type DatabaseClient, playerNameHistory, players } from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import { v7 as uuidv7 } from 'uuid';

/** Identity a new `players` row is created from; either identifier may be absent. */
export interface NewPlayerIdentity {
  steamId64: string | null;
  eosId: string | null;
  name: string;
}

/** True for a Postgres unique-violation (SQLSTATE 23505), also when wrapped as `cause`. */
export function isUniqueViolation(err: unknown): boolean {
  const candidate = err as { code?: string; cause?: { code?: string } };
  return candidate.code === '23505' || candidate.cause?.code === '23505';
}

/**
 * Creates a player with its first name-history row and the `player.created`
 * audit entry in one transaction, so a failure part-way leaves nothing behind.
 *
 * @param systemLabel - `actor_system_label` recorded on the audit entry.
 * @returns The new player id, or `null` when another writer created the same
 *   player first (unique violation); the caller re-resolves the existing row.
 * @throws Any error other than a unique violation (connection loss, ...).
 */
export async function createPlayerWithHistory(
  db: DatabaseClient,
  identity: NewPlayerIdentity,
  systemLabel: string,
): Promise<string | null> {
  const normalized = normalizePlayerName(identity.name);
  const playerId = uuidv7();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(players).values({
        id: playerId,
        steamId64: identity.steamId64 ? BigInt(identity.steamId64) : null,
        eosId: identity.eosId,
        canonicalName: identity.name,
        canonicalNameNormalized: normalized,
      });
      await tx.insert(playerNameHistory).values({
        playerId,
        name: identity.name,
        nameNormalized: normalized,
      });
      await tx.insert(auditLog).values({
        actorKind: 'system',
        actorSystemLabel: systemLabel,
        actionType: 'player.created',
        targetType: 'player',
        targetId: playerId,
        context: {
          eos_id: identity.eosId,
          steam_id64: identity.steamId64,
          canonical_name: identity.name,
        },
        rowHash: Buffer.from([]),
      });
    });
    return playerId;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}
