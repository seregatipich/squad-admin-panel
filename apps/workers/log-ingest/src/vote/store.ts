import {
  type DatabaseClient,
  events,
  gameVoteBallots,
  gameVotes,
  playerNameHistory,
  players,
} from '@squad/db';
import { normalizePlayerName } from '@squad/shared-config';
import { desc, eq, or } from 'drizzle-orm';
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
  for (const ballot of command.ballots) {
    const playerId = await resolvePlayer(db, ballot.voter);
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
