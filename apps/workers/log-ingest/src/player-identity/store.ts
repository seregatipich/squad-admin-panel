import {
  auditLog,
  type DatabaseClient,
  playerNameHistory,
  players,
  recordIpObservation,
} from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import type { EventEnvelope, PlayerConnectedPayload } from '@squad/shared-types';
import { eq, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

/** System label attributed to audit rows written by this worker. */
const SYSTEM_LABEL = 'log-ingest';

/** The canonical-identity row this handler needs to resolve a connect event. */
interface IdentityRow {
  id: string;
  steamId64: bigint | null;
  canonicalName: string;
  eosId: string | null;
  steamEosConflict: boolean;
}

export type PlayerConnectedOutcome =
  | { outcome: 'ignored' }
  | { outcome: 'created'; playerId: string }
  | {
      outcome: 'updated';
      playerId: string;
      nameChanged: boolean;
      steamLinked: boolean;
      conflict: boolean;
    };

async function writeSystemAudit(
  db: DatabaseClient,
  action: string,
  targetId: string,
  context: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    actorKind: 'system',
    actorSystemLabel: SYSTEM_LABEL,
    actionType: action,
    targetType: 'player',
    targetId,
    context: context as object,
    rowHash: Buffer.from([]),
  });
}

/**
 * Resolves the canonical identity row for a connect event, keyed on `eos_id`
 * (§1.1.2). When a `steam_id64` is present the lookup also matches by steam so
 * an eos-less row created elsewhere (e.g. an RCON poll) can be back-filled
 * rather than duplicated; the eos match still takes precedence for a row that
 * carries both.
 */
async function lookupIdentity(
  db: DatabaseClient,
  eosId: string | null,
  steamId64: bigint | null,
): Promise<IdentityRow | null> {
  const clause =
    eosId && steamId64 !== null
      ? or(eq(players.eosId, eosId), eq(players.steamId64, steamId64))
      : eosId
        ? eq(players.eosId, eosId)
        : steamId64 !== null
          ? eq(players.steamId64, steamId64)
          : null;
  if (!clause) return null;

  const rows = await db
    .select({
      id: players.id,
      steamId64: players.steamId64,
      canonicalName: players.canonicalName,
      eosId: players.eosId,
      steamEosConflict: players.steamEosConflict,
    })
    .from(players)
    .where(clause)
    .limit(1);
  return rows[0] ?? null;
}

async function applyToExisting(
  db: DatabaseClient,
  row: IdentityRow,
  payload: PlayerConnectedPayload,
  steamId64: bigint | null,
): Promise<PlayerConnectedOutcome> {
  const now = new Date();
  const updates: Record<string, unknown> = { lastSeenAt: now, updatedAt: now };

  if (!row.eosId && payload.eos_id) {
    updates.eosId = payload.eos_id;
  }

  let steamLinked = false;
  let conflict = false;
  if (steamId64 !== null) {
    if (row.steamId64 === null) {
      updates.steamId64 = steamId64;
      steamLinked = true;
    } else if (row.steamId64 !== steamId64) {
      // A known eos_id arriving with a different steam_id64: flag the identity,
      // store the last observed steam, and raise an audit-alert (§1.1.2).
      updates.steamId64 = steamId64;
      if (!row.steamEosConflict) updates.steamEosConflict = true;
      conflict = true;
    }
  }

  const nameChanged = row.canonicalName !== payload.name;
  if (nameChanged) {
    updates.canonicalName = payload.name;
    updates.canonicalNameNormalized = normalizePlayerName(payload.name);
  }

  await db.update(players).set(updates).where(eq(players.id, row.id));

  if (nameChanged) {
    const normalized = normalizePlayerName(payload.name);
    await db
      .insert(playerNameHistory)
      .values({ playerId: row.id, name: payload.name, nameNormalized: normalized })
      .onConflictDoUpdate({
        target: [playerNameHistory.playerId, playerNameHistory.nameNormalized],
        set: {
          lastSeenAt: now,
          observationCount: sql`${playerNameHistory.observationCount} + 1`,
        },
      });
  }

  if (steamLinked) {
    await writeSystemAudit(db, 'player.steam_linked', row.id, {
      steam_id64: payload.steam_id64,
      eos_id: payload.eos_id,
    });
  }

  if (conflict) {
    await writeSystemAudit(db, 'player.eos_steam_conflict', row.id, {
      eos_id: payload.eos_id,
      stored_steam_id64: row.steamId64?.toString() ?? null,
      observed_steam_id64: payload.steam_id64,
    });
  }

  if (payload.ip) {
    await recordIpObservation(db, { playerId: row.id, ip: payload.ip });
  }

  return { outcome: 'updated', playerId: row.id, nameChanged, steamLinked, conflict };
}

/**
 * Upserts the canonical player identity for one `player.connected` event,
 * keyed on `eos_id`, implementing the connection-handling algorithm of
 * §1.1.2 (PLAYER-1, #22). The operation is idempotent — a repeated event only
 * advances `last_seen_at` — and concurrent connects of the same player collapse
 * onto a single row via the partial-unique `players_eos_id_unique_idx`.
 *
 * Session creation is out of scope (PRES-1/#48); this only maintains identity.
 */
export async function handlePlayerConnected(
  db: DatabaseClient,
  event: EventEnvelope,
): Promise<PlayerConnectedOutcome> {
  if (event.type !== 'player.connected') return { outcome: 'ignored' };
  const payload = event.payload as PlayerConnectedPayload;
  const steamId64 = payload.steam_id64 ? BigInt(payload.steam_id64) : null;
  if (!payload.eos_id && steamId64 === null) return { outcome: 'ignored' };

  const existing = await lookupIdentity(db, payload.eos_id, steamId64);
  if (existing) {
    return applyToExisting(db, existing, payload, steamId64);
  }

  const playerId = uuidv7();
  const normalized = normalizePlayerName(payload.name);
  const inserted = await db
    .insert(players)
    .values({
      id: playerId,
      steamId64,
      eosId: payload.eos_id,
      canonicalName: payload.name,
      canonicalNameNormalized: normalized,
    })
    .onConflictDoNothing()
    .returning({ id: players.id });

  if (inserted.length === 0) {
    // A concurrent connect created the row first; fold onto it instead of
    // duplicating. If it still cannot be found the conflict was on a
    // constraint we do not own, so there is nothing safe to do.
    const raced = await lookupIdentity(db, payload.eos_id, steamId64);
    if (!raced) return { outcome: 'ignored' };
    return applyToExisting(db, raced, payload, steamId64);
  }

  await db
    .insert(playerNameHistory)
    .values({ playerId, name: payload.name, nameNormalized: normalized })
    .onConflictDoNothing();

  await writeSystemAudit(db, 'player.created', playerId, {
    steam_id64: payload.steam_id64,
    eos_id: payload.eos_id,
    canonical_name: payload.name,
  });

  if (payload.ip) {
    await recordIpObservation(db, { playerId, ip: payload.ip });
  }

  return { outcome: 'created', playerId };
}
