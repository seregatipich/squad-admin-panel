import {
  createDatabaseClient,
  events,
  gameVoteBallots,
  gameVotes,
  players,
  servers,
} from '@squad/db';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoteRecordCommand } from '../src/parser/vote.js';
import { handleVote, LIVE_BUS_CHANNEL } from '../src/vote/store.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the vote1 test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const INITIATOR_ID = uuidv7();
const VOTER_A_ID = uuidv7();
const VOTER_B_ID = uuidv7();
const INITIATOR_EOS = '0005aaaa0005aaaa0005aaaa0005aaaa';
const VOTER_A_EOS = '0005bbbb0005bbbb0005bbbb0005bbbb';
const VOTER_B_EOS = '0005cccc0005cccc0005cccc0005cccc';
const VOTER_B_STEAM = 76561198000500002n;

function makePublisher() {
  return { publish: vi.fn().mockResolvedValue(1) };
}

function makeCommand(overrides: Partial<VoteRecordCommand> = {}): VoteRecordCommand {
  const startedAt = overrides.startedAt ?? new Date().toISOString();
  return {
    kind: 'record',
    serverId: SERVER_ID,
    voteType: 'map_skip',
    initiator: { eosId: INITIATOR_EOS, steamId64: null, name: 'SkipGuy' },
    mapCurrent: 'Yehorivka_RAAS_v1',
    mapNext: 'Narva_AAS_v2',
    mapTarget: null,
    votesCollected: 2,
    votesRequired: 2,
    result: 'passed',
    startedAt,
    endedAt: new Date(new Date(startedAt).getTime() + 40_000).toISOString(),
    ballots: [
      {
        voter: { eosId: VOTER_A_EOS, steamId64: null, name: 'AlphaVoter' },
        choice: 'yes',
        votedAt: new Date(new Date(startedAt).getTime() + 5_000).toISOString(),
      },
      {
        voter: { eosId: VOTER_B_EOS, steamId64: String(VOTER_B_STEAM), name: 'BetaVoter' },
        choice: 'no',
        votedAt: new Date(new Date(startedAt).getTime() + 6_000).toISOString(),
      },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Vote Test Server',
    slug: `vote-test-${SERVER_ID.slice(0, 8)}`,
  });
  await db.insert(players).values([
    {
      id: INITIATOR_ID,
      eosId: INITIATOR_EOS,
      steamId64: null,
      canonicalName: 'SkipGuy',
      canonicalNameNormalized: 'skipguy',
    },
    {
      id: VOTER_A_ID,
      eosId: VOTER_A_EOS,
      steamId64: null,
      canonicalName: 'AlphaVoter',
      canonicalNameNormalized: 'alphavoter',
    },
    {
      id: VOTER_B_ID,
      eosId: VOTER_B_EOS,
      steamId64: VOTER_B_STEAM,
      canonicalName: 'BetaVoter',
      canonicalNameNormalized: 'betavoter',
    },
  ]);
});

afterAll(async () => {
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(gameVotes).where(eq(gameVotes.serverId, SERVER_ID));
  await db.delete(players).where(eq(players.id, INITIATOR_ID));
  await db.delete(players).where(eq(players.id, VOTER_A_ID));
  await db.delete(players).where(eq(players.id, VOTER_B_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(events).where(eq(events.serverId, SERVER_ID));
  await db.delete(gameVotes).where(eq(gameVotes.serverId, SERVER_ID));
});

describe('handleVote', () => {
  it('writes a game_votes row with resolved initiator, maps, counts and result', async () => {
    const result = await handleVote(db, makePublisher(), makeCommand());
    expect(result.inserted).toBe(true);
    expect(result.initiatorPlayerId).toBe(INITIATOR_ID);

    const rows = await db.select().from(gameVotes).where(eq(gameVotes.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(result.voteId);
    expect(row.initiatorPlayerId).toBe(INITIATOR_ID);
    expect(row.voteType).toBe('map_skip');
    expect(row.mapCurrent).toBe('Yehorivka_RAAS_v1');
    expect(row.mapNext).toBe('Narva_AAS_v2');
    expect(row.mapTarget).toBeNull();
    expect(row.votesCollected).toBe(2);
    expect(row.votesRequired).toBe(2);
    expect(row.result).toBe('passed');
    expect(row.durationSeconds).toBe(40);
  });

  it('stores per-name ballots with resolved player uuids (EOS-only and steam)', async () => {
    const result = await handleVote(db, makePublisher(), makeCommand());
    expect(result.ballotCount).toBe(2);

    const ballotRows = await db
      .select()
      .from(gameVoteBallots)
      .where(eq(gameVoteBallots.voteId, result.voteId as string));
    expect(ballotRows).toHaveLength(2);
    const alpha = ballotRows.find((b) => b.playerId === VOTER_A_ID);
    const beta = ballotRows.find((b) => b.playerId === VOTER_B_ID);
    expect(alpha?.choice).toBe('yes');
    expect(beta?.choice).toBe('no');
  });

  it('writes vote_started and vote_ended events correlated to the vote', async () => {
    const result = await handleVote(db, makePublisher(), makeCommand());
    const started = await db
      .select()
      .from(events)
      .where(and(eq(events.serverId, SERVER_ID), eq(events.kind, 'vote_started')));
    const ended = await db
      .select()
      .from(events)
      .where(and(eq(events.serverId, SERVER_ID), eq(events.kind, 'vote_ended')));
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(started[0].correlationId).toBe(result.voteId);
    expect(ended[0].correlationId).toBe(result.voteId);
    const payload = ended[0].payload as Record<string, unknown>;
    expect(payload.vote_id).toBe(result.voteId);
    expect(payload.result).toBe('passed');
    expect(payload.initiator_player_id).toBe(INITIATOR_ID);
  });

  it('publishes a vote.ended frame on the live-bus channel', async () => {
    const publisher = makePublisher();
    const result = await handleVote(db, publisher, makeCommand());
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = publisher.publish.mock.calls[0];
    expect(channel).toBe(LIVE_BUS_CHANNEL);
    const frame = JSON.parse(raw as string);
    expect(frame.type).toBe('vote.ended');
    expect(frame.data.vote_id).toBe(result.voteId);
    expect(frame.data.result).toBe('passed');
    expect(frame.data.votes_collected).toBe(2);
  });

  it('records a server-restart mid-vote as cancelled, not a dangling open row', async () => {
    const result = await handleVote(
      db,
      makePublisher(),
      makeCommand({ result: 'cancelled', votesCollected: 1, votesRequired: 25 }),
    );
    expect(result.inserted).toBe(true);
    const rows = await db.select().from(gameVotes).where(eq(gameVotes.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe('cancelled');
    expect(rows[0].endedAt).not.toBeNull();
  });

  it('keeps an unresolved initiator as null while still recording the vote', async () => {
    const result = await handleVote(
      db,
      makePublisher(),
      makeCommand({
        initiator: { eosId: 'ffffffffffffffffffffffffffffffff', steamId64: null, name: 'Ghost' },
      }),
    );
    expect(result.initiatorPlayerId).toBeNull();
    const rows = await db.select().from(gameVotes).where(eq(gameVotes.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].initiatorPlayerId).toBeNull();
  });

  it('is idempotent for a duplicate vote at the same server and start time', async () => {
    const startedAt = new Date().toISOString();
    const first = await handleVote(db, makePublisher(), makeCommand({ startedAt }));
    const second = await handleVote(db, makePublisher(), makeCommand({ startedAt }));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    const rows = await db.select().from(gameVotes).where(eq(gameVotes.serverId, SERVER_ID));
    expect(rows).toHaveLength(1);
    const eventRows = await db.select().from(events).where(eq(events.serverId, SERVER_ID));
    expect(eventRows).toHaveLength(2);
  });
});
