import {
  auditLog,
  type ClosedReason,
  type DatabaseClient,
  type GeoLookup,
  playerKitTime,
  playerNameHistory,
  playerSessions,
  players,
  recordIpObservation,
  resolveGeo,
  type SessionMode,
} from '@squad/db';
import { normalizePlayerName, normalizeRoleName } from '@squad/shared-config';
import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
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

/**
 * Longest stretch of unobserved time, expressed in poll intervals, that a
 * newly opened session may be backdated by. The roster's `first_seen_at` is
 * kept across an RCON reconnect, so without this clamp a reconnect would
 * credit the whole offline gap as play time.
 */
const MAX_BACKDATE_POLL_INTERVALS = 2;

export interface ReconcilePlayerSessionsInput {
  /** `servers.id` the roster was polled against. */
  serverId: string;
  /** Players parsed from the current `ListPlayers` response. */
  onlinePlayers: RconPlayer[];
  /** Instant of this poll; the close timestamp for players who have left. */
  pollAt: Date;
  /** `eos_id` → roster `first_seen_at` (ISO), from {@link buildRoster}. */
  firstSeenByEosId?: Map<string, string>;
  /** Mode to open new sessions in; `seed` while the server is seeding. */
  mode?: SessionMode;
  /** Supervisor poll cadence, used to clamp how far a session is backdated. */
  pollIntervalMs?: number;
}

export interface ReconcilePlayerSessionsResult {
  opened: number;
  closed: number;
}

/**
 * Reconciles `player_sessions` for one server against a `ListPlayers`
 * snapshot: opens a session for every online player that has none, and closes
 * the open sessions of players who are no longer on the roster.
 *
 * The snapshot — not the log stream — is the source of truth for presence:
 * every poll is a full roster, so a dropped log tail or a missed disconnect
 * line self-heals at the next poll instead of leaving a session open forever.
 *
 * Sessions are opened at the roster's `first_seen_at` when it is known, so a
 * player who joined between polls is not charged the full poll interval; the
 * backdate is clamped to {@link MAX_BACKDATE_POLL_INTERVALS} poll intervals so
 * a stale first-seen entry (kept across an RCON reconnect) cannot credit
 * offline time.
 *
 * @param db - Database client.
 * @param input - Server, roster snapshot, poll instant, and open mode.
 * @returns Counts of sessions opened and closed by this reconcile.
 */
export async function reconcilePlayerSessions(
  db: DatabaseClient,
  input: ReconcilePlayerSessionsInput,
): Promise<ReconcilePlayerSessionsResult> {
  const { serverId, onlinePlayers, pollAt } = input;
  const mode = input.mode ?? 'online';
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const onlineIds = await resolvePlayerIds(db, onlinePlayers);

  const closed = await db
    .update(playerSessions)
    .set({
      disconnectedAt: pollAt,
      durationSeconds: closedDurationSeconds(pollAt),
      closedReason: 'disconnect',
    })
    .where(
      and(
        eq(playerSessions.serverId, serverId),
        isNull(playerSessions.disconnectedAt),
        onlineIds.size > 0 ? notInArray(playerSessions.playerId, [...onlineIds.keys()]) : undefined,
      ),
    )
    .returning({ id: playerSessions.id });

  if (onlineIds.size === 0) return { opened: 0, closed: closed.length };

  const openRows = await db
    .select({ playerId: playerSessions.playerId })
    .from(playerSessions)
    .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.disconnectedAt)));
  const alreadyOpen = new Set(openRows.map((row) => row.playerId));

  const earliestMs = pollAt.getTime() - MAX_BACKDATE_POLL_INTERVALS * pollIntervalMs;
  const toOpen = [...onlineIds]
    .filter(([playerId]) => !alreadyOpen.has(playerId))
    .map(([playerId, eosId]) => ({
      playerId,
      serverId,
      connectedAt: connectedAtFor(input.firstSeenByEosId?.get(eosId), earliestMs, pollAt),
      mode,
    }));
  if (toOpen.length === 0) return { opened: 0, closed: closed.length };

  await db.insert(playerSessions).values(toOpen);
  return { opened: toOpen.length, closed: closed.length };
}

/**
 * Closes every open session of one server — used when the RCON connection
 * drops or the supervisor stops, so players are not left "online" forever
 * while presence queries extrapolate an open session up to `now()`.
 *
 * @param db - Database client.
 * @param serverId - `servers.id` whose sessions are closed.
 * @param closedAt - Close instant; pass the last successful poll, not `now`,
 *   so the unobserved gap since that poll is not credited as play time.
 * @param reason - `closed_reason` to record.
 * @returns Number of sessions closed.
 */
export async function closeServerSessions(
  db: DatabaseClient,
  serverId: string,
  closedAt: Date,
  reason: ClosedReason = 'disconnect',
): Promise<number> {
  const closed = await db
    .update(playerSessions)
    .set({
      disconnectedAt: closedAt,
      durationSeconds: closedDurationSeconds(closedAt),
      closedReason: reason,
    })
    .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.disconnectedAt)))
    .returning({ id: playerSessions.id });
  return closed.length;
}

function closedDurationSeconds(closedAt: Date) {
  return sql<number>`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${closedAt.toISOString()}::timestamptz - ${playerSessions.connectedAt}))))::int`;
}

function connectedAtFor(firstSeenAt: string | undefined, earliestMs: number, pollAt: Date): Date {
  const firstSeenMs = firstSeenAt ? Date.parse(firstSeenAt) : Number.NaN;
  if (!Number.isFinite(firstSeenMs)) return pollAt;
  return new Date(Math.min(pollAt.getTime(), Math.max(earliestMs, firstSeenMs)));
}

/** Resolves roster entries to `players.id`, keyed by id → the entry's `eos_id`. */
async function resolvePlayerIds(
  db: DatabaseClient,
  roster: RconPlayer[],
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (roster.length === 0) return resolved;

  const eosIds = roster.map((p) => p.eos_id);
  const steamIds = roster.filter((p) => p.steam_id64).map((p) => BigInt(p.steam_id64 as string));
  const rows = await db
    .select({ id: players.id, eosId: players.eosId, steamId64: players.steamId64 })
    .from(players)
    .where(
      or(
        inArray(players.eosId, eosIds),
        steamIds.length > 0 ? inArray(players.steamId64, steamIds) : undefined,
      ),
    );

  const byEos = new Map(rows.filter((r) => r.eosId).map((r) => [r.eosId as string, r.id]));
  const bySteam = new Map(
    rows.filter((r) => r.steamId64 !== null).map((r) => [String(r.steamId64), r.id]),
  );
  for (const p of roster) {
    const id = byEos.get(p.eos_id) ?? (p.steam_id64 ? bySteam.get(p.steam_id64) : undefined);
    if (id) resolved.set(id, p.eos_id);
  }
  return resolved;
}
