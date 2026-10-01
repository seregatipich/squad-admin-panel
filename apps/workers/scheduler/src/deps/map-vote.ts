import type { DatabaseClient } from '@squad/db';
import {
  layers,
  mapVoteCandidates,
  mapVotePicks,
  matches,
  serverSettings,
  servers,
} from '@squad/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type Redis from 'ioredis';
import type {
  MapVoteCandidateEntry,
  MapVoteServerEntry,
  MapVoteTickDeps,
} from '../map-vote-tick.js';
import { isDepotUpdating, sendRconCommand, writeSystemAuditEntry } from './shared.js';

/** Loads servers with GAME-1 (#80) map auto-selection enabled. */
export async function loadEnabledMapVoteServers(db: DatabaseClient): Promise<MapVoteServerEntry[]> {
  return db
    .select({
      serverId: serverSettings.serverId,
      selection: serverSettings.mapVoteSelection,
      layerCooldown: serverSettings.mapVoteLayerCooldown,
      mapCooldown: serverSettings.mapVoteMapCooldown,
    })
    .from(serverSettings)
    .innerJoin(servers, eq(servers.id, serverSettings.serverId))
    .where(and(eq(serverSettings.mapVoteEnabled, true), isNull(servers.deletedAt)));
}

/** Newest match (open or finished) for a server — the GAME-1 dedup anchor. */
export async function getLatestMatchForMapVote(
  db: DatabaseClient,
  serverId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: matches.id })
    .from(matches)
    .where(eq(matches.serverId, serverId))
    .orderBy(desc(matches.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function hasMapVotePickForMatch(
  db: DatabaseClient,
  matchId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: mapVotePicks.id })
    .from(mapVotePicks)
    .where(eq(mapVotePicks.matchId, matchId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Candidate pool joined against the `layers` catalog for map/deprecated
 * metadata. Rows whose layer left the catalog drop out (they could never be
 * validated for `AdminSetNextLayer` anyway).
 */
export async function loadMapVoteCandidates(
  db: DatabaseClient,
  serverId: string,
): Promise<MapVoteCandidateEntry[]> {
  return db
    .select({
      layer: mapVoteCandidates.layer,
      map: layers.map,
      weight: mapVoteCandidates.weight,
      enabled: mapVoteCandidates.enabled,
      deprecated: layers.deprecated,
    })
    .from(mapVoteCandidates)
    .innerJoin(layers, eq(layers.name, mapVoteCandidates.layer))
    .where(eq(mapVoteCandidates.serverId, serverId));
}

const MAP_VOTE_RECENT_MATCH_LIMIT = 50;

/** Recent matches (newest first, open match included) for cooldown checks. */
export async function loadRecentMatchesForMapVote(
  db: DatabaseClient,
  serverId: string,
): Promise<Array<{ layer: string; map: string; isSeed: boolean }>> {
  const rows = await db
    .select({ layer: matches.layer, map: matches.map, isSeed: matches.isSeed })
    .from(matches)
    .where(eq(matches.serverId, serverId))
    .orderBy(desc(matches.startedAt))
    .limit(MAP_VOTE_RECENT_MATCH_LIMIT);
  return rows
    .filter((row): row is { layer: string; map: string | null; isSeed: boolean } =>
      Boolean(row.layer),
    )
    .map((row) => ({ layer: row.layer, map: row.map ?? '', isSeed: row.isSeed }));
}

/**
 * Claims the per-match pick row. `ON CONFLICT (match_id) DO NOTHING
 * RETURNING` returns no id when another tick already inserted the row — the
 * caller must then send nothing (GAME-1 idempotency).
 */
export async function insertMapVotePick(
  db: DatabaseClient,
  pick: {
    serverId: string;
    matchId: string;
    layer: string;
    selection: MapVoteServerEntry['selection'];
    candidateSnapshot: MapVoteCandidateEntry[];
    rngSeed: string;
  },
): Promise<string | null> {
  const rows = await db
    .insert(mapVotePicks)
    .values({
      serverId: pick.serverId,
      matchId: pick.matchId,
      layer: pick.layer,
      selection: pick.selection,
      candidateSnapshot: pick.candidateSnapshot,
      rngSeed: pick.rngSeed,
    })
    .onConflictDoNothing({ target: mapVotePicks.matchId })
    .returning({ id: mapVotePicks.id });
  return rows[0]?.id ?? null;
}

export async function markMapVotePickApplied(db: DatabaseClient, pickId: string): Promise<void> {
  await db.update(mapVotePicks).set({ applied: true }).where(eq(mapVotePicks.id, pickId));
}

export async function setMapVotePickFailure(
  db: DatabaseClient,
  pickId: string,
  reason: string,
): Promise<void> {
  await db.update(mapVotePicks).set({ failureReason: reason }).where(eq(mapVotePicks.id, pickId));
}

export function createMapVoteDeps(
  db: DatabaseClient,
  redis: Pick<Redis, 'get' | 'xadd'>,
): Omit<MapVoteTickDeps, 'diag'> {
  return {
    loadEnabledServers: () => loadEnabledMapVoteServers(db),
    getLatestMatch: (serverId) => getLatestMatchForMapVote(db, serverId),
    hasPickForMatch: (matchId) => hasMapVotePickForMatch(db, matchId),
    loadCandidates: (serverId) => loadMapVoteCandidates(db, serverId),
    loadRecentMatches: (serverId) => loadRecentMatchesForMapVote(db, serverId),
    insertPick: (pick) => insertMapVotePick(db, pick),
    markPickApplied: (pickId) => markMapVotePickApplied(db, pickId),
    setPickFailure: (pickId, reason) => setMapVotePickFailure(db, pickId, reason),
    isDepotUpdating: () => isDepotUpdating(redis),
    sendRconCommand: (input, requestId) => sendRconCommand(redis, input, requestId),
    writeAuditEntry: (entry) => writeSystemAuditEntry(db, entry),
  };
}
