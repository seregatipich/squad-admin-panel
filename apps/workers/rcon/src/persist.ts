import {
  auditLog,
  type DatabaseClient,
  type GeoLookup,
  playerKitTime,
  playerNameHistory,
  players,
  recordIpObservation,
  resolveGeo,
} from '@squad/db';
import { normalizePlayerName, normalizeRoleName } from '@squad/shared-config';
import { eq, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { RconPlayer } from './parse-list-players.js';

/** Default `ListPlayers` poll cadence (ms); mirrors `SupervisorOptions.pollIntervalMs` in supervisor.ts. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

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

export async function upsertPlayers(
  db: DatabaseClient,
  incoming: RconPlayer[],
  geoLookup: GeoLookup | null = null,
): Promise<void> {
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

      if (p.ip) {
        await recordIpObservation(db, {
          playerId,
          ip: p.ip,
          geo: resolveGeo(geoLookup, p.ip),
        });
      }
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

      if (p.ip) {
        await recordIpObservation(db, {
          playerId,
          ip: p.ip,
          geo: resolveGeo(geoLookup, p.ip),
        });
      }
    }
  }
}

/**
 * Accrue per-kit playtime (DOSSIER-3, issue #190) for the players online at
 * this `ListPlayers` poll.
 *
 * The elapsed time since `prevPollAt` is attributed, per online player, to
 * the kit they currently hold (their `role` field normalized via
 * {@link normalizeRoleName}). Because the worker only observes role at poll
 * granularity, a role change is only detected at the next poll — the
 * accrued interval is an approximation bounded by the poll interval, which
 * is what the DOSSIER-3 acceptance criteria expect. Players with no
 * resolvable identity (should not normally happen once `upsertPlayers` has
 * run for the same poll) or a role that does not normalize to a known kit
 * (`null`/unrecognized role-string) accrue nothing.
 *
 * `prevPollAt` must be `null` on the first poll after a (re)connect — the
 * caller has no known-good starting instant for that interval, so nothing is
 * accrued and the interval is not fabricated. Intervals longer than
 * `2 * pollIntervalMs` (e.g. a delayed poll after backpressure) are clamped
 * to `pollIntervalMs` to avoid crediting downtime as playtime.
 *
 * @param db - Database client.
 * @param onlinePlayers - Players parsed from the current `ListPlayers` response.
 * @param prevPollAt - Timestamp of the previous successful poll for this
 *   supervisor connection, or `null` if this is the first poll since (re)connect.
 * @param nowPollAt - Timestamp of the current poll.
 * @param serverId - The `servers.id` this poll was taken against.
 * @param pollIntervalMs - The supervisor's configured poll interval, used to
 *   clamp abnormally long gaps between polls. Defaults to 30s.
 */
export async function accruePlayerKitTime(
  db: DatabaseClient,
  onlinePlayers: RconPlayer[],
  prevPollAt: Date | null,
  nowPollAt: Date,
  serverId: string,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): Promise<void> {
  if (!prevPollAt) return;

  const elapsedMs = nowPollAt.getTime() - prevPollAt.getTime();
  if (elapsedMs <= 0) return;

  const clampedMs = elapsedMs > 2 * pollIntervalMs ? pollIntervalMs : elapsedMs;
  const deltaSeconds = Math.round(clampedMs / 1000);
  if (deltaSeconds <= 0) return;

  for (const p of onlinePlayers) {
    const kit = normalizeRoleName(p.role);
    if (!kit) continue;

    const steamBigint = p.steam_id64 ? BigInt(p.steam_id64) : null;
    const matchClause =
      steamBigint === null
        ? eq(players.eosId, p.eos_id)
        : or(eq(players.eosId, p.eos_id), eq(players.steamId64, steamBigint));

    const existing = await db.select({ id: players.id }).from(players).where(matchClause).limit(1);
    const playerId = existing[0]?.id;
    if (!playerId) continue;

    await db
      .insert(playerKitTime)
      .values({
        playerId,
        kit,
        serverId,
        seconds: deltaSeconds,
        lastPlayedAt: nowPollAt,
      })
      .onConflictDoUpdate({
        target: [playerKitTime.playerId, playerKitTime.kit, playerKitTime.serverId],
        set: {
          seconds: sql`${playerKitTime.seconds} + ${deltaSeconds}`,
          lastPlayedAt: nowPollAt,
        },
      });
  }
}
