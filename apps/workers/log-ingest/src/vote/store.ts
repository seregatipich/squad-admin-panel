import {
  type DatabaseClient,
  events,
  gameVoteBallots,
  gameVotes,
  playerNameHistory,
  players,
} from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import { desc, eq, inArray, or } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { VoteIdentity, VoteRecordCommand } from '../parser/vote.js';

export const LIVE_BUS_CHANNEL = 'live-bus';

export interface VotePublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface HandleVoteResult {
  voteId: string | null;
  inserted: boolean;
  initiatorPlayerId: string | null;
  ballotCount: number;
}

async function resolveByIdentity(
  db: DatabaseClient,
  identity: { eosId: string | null; steamId64: string | null },
): Promise<string | null> {
  const filters = [];
  if (identity.eosId) filters.push(eq(players.eosId, identity.eosId));
  if (identity.steamId64) filters.push(eq(players.steamId64, BigInt(identity.steamId64)));
  if (filters.length === 0) return null;
  const rows = await db
    .select({ id: players.id })
    .from(players)
    .where(filters.length === 1 ? filters[0] : or(...filters))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function resolveByName(db: DatabaseClient, rawName: string): Promise<string | null> {
  const normalized = normalizePlayerName(rawName);
  if (!normalized) return null;
  const direct = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.canonicalNameNormalized, normalized))
    .orderBy(desc(players.lastSeenAt))
    .limit(1);
  if (direct[0]) return direct[0].id;
  const historical = await db
    .select({ id: playerNameHistory.playerId })
    .from(playerNameHistory)
    .where(eq(playerNameHistory.nameNormalized, normalized))
    .orderBy(desc(playerNameHistory.lastSeenAt))
    .limit(1);
  return historical[0]?.id ?? null;
}

async function resolvePlayer(db: DatabaseClient, identity: VoteIdentity): Promise<string | null> {
  const byId = await resolveByIdentity(db, {
    eosId: identity.eosId,
    steamId64: identity.steamId64,
  });
  if (byId) return byId;
  return resolveByName(db, identity.name);
}

/**
 * Resolves many voters in three queries at most (by EOS/Steam id, by canonical
 * name, by name history) instead of up to three per voter. Precedence matches
 * {@link resolvePlayer}: an id match wins over a name match, and among several
 * players sharing a name the most recently seen one wins.
 *
 * @returns player ids in the order of `identities`; `null` where unresolved.
 */
async function resolvePlayers(
  db: DatabaseClient,
  identities: VoteIdentity[],
): Promise<Array<string | null>> {
  const eosIds = [...new Set(identities.flatMap((i) => (i.eosId ? [i.eosId] : [])))];
  const steamIds = [
    ...new Set(identities.flatMap((i) => (i.steamId64 ? [BigInt(i.steamId64)] : []))),
  ];
  const idFilters = [
    ...(eosIds.length > 0 ? [inArray(players.eosId, eosIds)] : []),
    ...(steamIds.length > 0 ? [inArray(players.steamId64, steamIds)] : []),
  ];
  const byEos = new Map<string, string>();
  const bySteam = new Map<string, string>();
  if (idFilters.length > 0) {
    const rows = await db
      .select({ id: players.id, eosId: players.eosId, steamId64: players.steamId64 })
      .from(players)
      .where(or(...idFilters));
    for (const row of rows) {
      if (row.eosId) byEos.set(row.eosId, row.id);
      if (row.steamId64 !== null) bySteam.set(String(row.steamId64), row.id);
    }
  }

  const resolved = identities.map((identity) => {
    const byEosId = identity.eosId ? byEos.get(identity.eosId) : undefined;
    const bySteamId = identity.steamId64 ? bySteam.get(identity.steamId64) : undefined;
    return byEosId ?? bySteamId ?? null;
  });

  const normalizedNames = identities.map((identity) => normalizePlayerName(identity.name));
  const unresolvedNames = [
    ...new Set(normalizedNames.filter((name, i) => name && resolved[i] === null)),
  ] as string[];
  if (unresolvedNames.length === 0) return resolved;

  const byName = new Map<string, string>();
  const directRows = await db
    .select({ id: players.id, name: players.canonicalNameNormalized })
    .from(players)
    .where(inArray(players.canonicalNameNormalized, unresolvedNames))
    .orderBy(desc(players.lastSeenAt));
  for (const row of directRows) {
    if (row.name && !byName.has(row.name)) byName.set(row.name, row.id);
  }

  const missingNames = unresolvedNames.filter((name) => !byName.has(name));
  if (missingNames.length > 0) {
    const historyRows = await db
      .select({ id: playerNameHistory.playerId, name: playerNameHistory.nameNormalized })
      .from(playerNameHistory)
      .where(inArray(playerNameHistory.nameNormalized, missingNames))
      .orderBy(desc(playerNameHistory.lastSeenAt));
    for (const row of historyRows) {
      if (!byName.has(row.name)) byName.set(row.name, row.id);
    }
  }

  return resolved.map((id, i) => {
    if (id !== null) return id;
    const name = normalizedNames[i];
    return name ? (byName.get(name) ?? null) : null;
  });
}

type VoteWriter = Pick<DatabaseClient, 'insert'>;

async function writeVoteEvent(
  db: VoteWriter,
  params: {
    serverId: string;
    voteId: string;
    kind: 'vote_started' | 'vote_ended';
    occurredAt: Date;
    initiatorPlayerId: string | null;
    command: VoteRecordCommand;
  },
): Promise<void> {
  await db.insert(events).values({
    eventId: uuidv7(),
    serverId: params.serverId,
    occurredAt: params.occurredAt,
    kind: params.kind,
    version: 1,
    actorKind: 'system',
    actorId: params.initiatorPlayerId,
    correlationId: params.voteId,
    payload: {
      vote_id: params.voteId,
      vote_type: params.command.voteType,
      initiator_player_id: params.initiatorPlayerId,
      map_current: params.command.mapCurrent,
      map_next: params.command.mapNext,
      map_target: params.command.mapTarget,
      votes_collected: params.command.votesCollected,
      votes_required: params.command.votesRequired,
      result: params.command.result,
    },
  });
}

export async function handleVote(
  db: DatabaseClient,
  redis: VotePublisher | null,
  command: VoteRecordCommand,
): Promise<HandleVoteResult> {
  const startedAt = new Date(command.startedAt);
  const endedAt = new Date(command.endedAt);
  const durationSeconds = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));

  const initiatorPlayerId = command.initiator ? await resolvePlayer(db, command.initiator) : null;

  const voteId = uuidv7();
  const ballotRows: Array<typeof gameVoteBallots.$inferInsert> = [];
  const voterIds = await resolvePlayers(
    db,
    command.ballots.map((ballot) => ballot.voter),
  );
  for (const [index, ballot] of command.ballots.entries()) {
    const playerId = voterIds[index];
    if (!playerId) continue;
    ballotRows.push({
      voteId,
      playerId,
      choice: ballot.choice,
      votedAt: new Date(ballot.votedAt),
    });
  }

  // The vote row, its ballots and both events commit together: a failure part
  // way through must not leave a game_votes row that blocks the re-read of the
  // same log line (conflict on server_id + started_at) from completing them.
  const inserted = await db.transaction(async (tx) => {
    const votes = await tx
      .insert(gameVotes)
      .values({
        id: voteId,
        serverId: command.serverId,
        initiatorPlayerId,
        voteType: command.voteType,
        mapCurrent: command.mapCurrent,
        mapNext: command.mapNext,
        mapTarget: command.mapTarget,
        votesCollected: command.votesCollected,
        votesRequired: command.votesRequired,
        result: command.result,
        durationSeconds,
        startedAt,
        endedAt,
      })
      .onConflictDoNothing({ target: [gameVotes.serverId, gameVotes.startedAt] })
      .returning({ id: gameVotes.id });
    if (votes.length === 0) return false;

    if (ballotRows.length > 0) {
      await tx
        .insert(gameVoteBallots)
        .values(ballotRows)
        .onConflictDoNothing({ target: [gameVoteBallots.voteId, gameVoteBallots.playerId] });
    }

    await writeVoteEvent(tx, {
      serverId: command.serverId,
      voteId,
      kind: 'vote_started',
      occurredAt: startedAt,
      initiatorPlayerId,
      command,
    });
    await writeVoteEvent(tx, {
      serverId: command.serverId,
      voteId,
      kind: 'vote_ended',
      occurredAt: endedAt,
      initiatorPlayerId,
      command,
    });
    return true;
  });

  if (!inserted) {
    return { voteId: null, inserted: false, initiatorPlayerId, ballotCount: 0 };
  }

  if (redis) {
    const frame = JSON.stringify({
      type: 'vote.ended',
      ts: new Date().toISOString(),
      data: {
        vote_id: voteId,
        server_id: command.serverId,
        vote_type: command.voteType,
        initiator_player_id: initiatorPlayerId,
        map_current: command.mapCurrent,
        map_next: command.mapNext,
        map_target: command.mapTarget,
        votes_collected: command.votesCollected,
        votes_required: command.votesRequired,
        result: command.result,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
      },
    });
    await redis.publish(LIVE_BUS_CHANNEL, frame);
  }

  return { voteId, inserted: true, initiatorPlayerId, ballotCount: ballotRows.length };
}
