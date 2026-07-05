import { describe, expect, it } from 'vitest';
import { LogIngestor } from '../src/parser/ingest.js';
import { parseLine } from '../src/parser/patterns.js';
import {
  parseVoteBallot,
  parseVoteEnd,
  parseVoteStart,
  VoteAssembler,
  type VoteRecordCommand,
} from '../src/parser/vote.js';

const SERVER_ID = '01903f7d-6a15-7c81-aa91-1e4fa9f9b7c5';
const INITIATOR_EOS = '0002aaaa0002aaaa0002aaaa0002aaaa';
const VOTER_A_EOS = '0002bbbb0002bbbb0002bbbb0002bbbb';
const VOTER_B_EOS = '0002cccc0002cccc0002cccc0002cccc';
const VOTER_STEAM = '76561198012345678';

function parse(raw: string) {
  const parsed = parseLine(raw);
  if (!parsed) throw new Error(`unparseable line: ${raw}`);
  return parsed;
}

describe('parseVoteStart', () => {
  it('parses a map skip vote start with EOS-only initiator and current/next layers', () => {
    const raw = `[2026.04.23-11.30.20:485][234]LogSquadVoteSystem: Display: Vote started: id=17 type=SkipMap initiator=[Online IDs: EOS: ${INITIATOR_EOS}] SkipGuy current=Yehorivka_RAAS_v1 next=Narva_AAS_v2 required=25`;
    const start = parseVoteStart(parse(raw));
    expect(start).not.toBeNull();
    if (!start) return;
    expect(start.voteType).toBe('map_skip');
    expect(start.initiator?.eosId).toBe(INITIATOR_EOS);
    expect(start.initiator?.steamId64).toBeNull();
    expect(start.initiator?.name).toBe('SkipGuy');
    expect(start.mapCurrent).toBe('Yehorivka_RAAS_v1');
    expect(start.mapNext).toBe('Narva_AAS_v2');
    expect(start.mapTarget).toBeNull();
    expect(start.votesRequired).toBe(25);
    expect(start.ts).toBe('2026-04-23T11:30:20.485Z');
  });

  it('parses a map change vote with a target layer and a steam-backed initiator', () => {
    const raw = `[2026.04.23-12.00.00:000][10]LogSquadVoteSystem: Display: Vote started: id=8 type=ChangeLayer initiator=[Online IDs: EOS: ${INITIATOR_EOS} steam: ${VOTER_STEAM}] Chooser current=Gorodok_AAS_v1 target=Mutaha_RAAS_v2 required=30`;
    const start = parseVoteStart(parse(raw));
    expect(start?.voteType).toBe('map_change');
    expect(start?.initiator?.steamId64).toBe(VOTER_STEAM);
    expect(start?.mapCurrent).toBe('Gorodok_AAS_v1');
    expect(start?.mapNext).toBeNull();
    expect(start?.mapTarget).toBe('Mutaha_RAAS_v2');
    expect(start?.votesRequired).toBe(30);
  });

  it('maps an admin-initiated vote to the admin type', () => {
    const raw = `[2026.04.23-12.05.00:000][10]LogSquadVoteSystem: Display: Vote started: type=Admin initiator=[Online IDs: EOS: ${INITIATOR_EOS}] AdminUser current=Fallujah_RAAS_v1 required=1`;
    const start = parseVoteStart(parse(raw));
    expect(start?.voteType).toBe('admin');
    expect(start?.mapNext).toBeNull();
    expect(start?.mapTarget).toBeNull();
  });

  it('returns null for a non-vote category line', () => {
    const raw = '[2026.04.23-12.05.00:000][10]LogSquad: ChatMessage: PlainName : ChatAll : hello';
    expect(parseVoteStart(parse(raw))).toBeNull();
  });
});

describe('parseVoteBallot', () => {
  it('parses a yes ballot with an EOS-only voter', () => {
    const raw = `[2026.04.23-11.30.25:000][240]LogSquadVoteSystem: Display: Vote registered: id=17 voter=[Online IDs: EOS: ${VOTER_A_EOS}] AlphaVoter choice=Yes`;
    const ballot = parseVoteBallot(parse(raw));
    expect(ballot?.voter.eosId).toBe(VOTER_A_EOS);
    expect(ballot?.voter.name).toBe('AlphaVoter');
    expect(ballot?.choice).toBe('yes');
  });

  it('parses a no ballot', () => {
    const raw = `[2026.04.23-11.30.26:000][241]LogSquadVoteSystem: Display: Vote registered: voter=[Online IDs: EOS: ${VOTER_B_EOS}] BetaVoter choice=No`;
    const ballot = parseVoteBallot(parse(raw));
    expect(ballot?.choice).toBe('no');
  });
});

describe('parseVoteEnd', () => {
  it('parses a passed result with collected/required tally', () => {
    const raw =
      '[2026.04.23-11.31.00:000][300]LogSquadVoteSystem: Display: Vote finished: id=17 result=Passed votes=26/25';
    const end = parseVoteEnd(parse(raw));
    expect(end?.result).toBe('passed');
    expect(end?.votesCollected).toBe(26);
    expect(end?.votesRequired).toBe(25);
  });

  it('parses a failed result', () => {
    const raw =
      '[2026.04.23-11.31.00:000][300]LogSquadVoteSystem: Display: Vote finished: result=Failed votes=3/25';
    const end = parseVoteEnd(parse(raw));
    expect(end?.result).toBe('failed');
    expect(end?.votesCollected).toBe(3);
  });
});

describe('VoteAssembler', () => {
  it('assembles a completed vote into one record with deduped ballots', () => {
    const assembler = new VoteAssembler(SERVER_ID);
    expect(
      assembler.onVoteStart({
        ts: '2026-04-23T11:30:20.000Z',
        voteType: 'map_skip',
        initiator: { eosId: INITIATOR_EOS, steamId64: null, name: 'SkipGuy' },
        mapCurrent: 'Yehorivka_RAAS_v1',
        mapNext: 'Narva_AAS_v2',
        mapTarget: null,
        votesRequired: 2,
      }),
    ).toHaveLength(0);
    assembler.onVoteBallot({
      ts: '2026-04-23T11:30:25.000Z',
      voter: { eosId: VOTER_A_EOS, steamId64: null, name: 'AlphaVoter' },
      choice: 'no',
    });
    assembler.onVoteBallot({
      ts: '2026-04-23T11:30:26.000Z',
      voter: { eosId: VOTER_A_EOS, steamId64: null, name: 'AlphaVoter' },
      choice: 'yes',
    });
    assembler.onVoteBallot({
      ts: '2026-04-23T11:30:27.000Z',
      voter: { eosId: VOTER_B_EOS, steamId64: null, name: 'BetaVoter' },
      choice: 'yes',
    });
    const commands = assembler.onVoteEnd({
      ts: '2026-04-23T11:31:00.000Z',
      result: 'passed',
      votesCollected: 2,
      votesRequired: 2,
    });
    expect(commands).toHaveLength(1);
    const record = commands[0];
    expect(record.result).toBe('passed');
    expect(record.votesCollected).toBe(2);
    expect(record.ballots).toHaveLength(2);
    const alpha = record.ballots.find((b) => b.voter.eosId === VOTER_A_EOS);
    expect(alpha?.choice).toBe('yes');
    expect(record.startedAt).toBe('2026-04-23T11:30:20.000Z');
    expect(record.endedAt).toBe('2026-04-23T11:31:00.000Z');
    expect(assembler.hasOpenVote()).toBe(false);
  });

  it('closes an open vote as cancelled on server-down without a dangling vote', () => {
    const assembler = new VoteAssembler(SERVER_ID);
    assembler.onVoteStart({
      ts: '2026-04-23T11:30:20.000Z',
      voteType: 'map_skip',
      initiator: null,
      mapCurrent: 'Yehorivka_RAAS_v1',
      mapNext: null,
      mapTarget: null,
      votesRequired: 25,
    });
    assembler.onVoteBallot({
      ts: '2026-04-23T11:30:25.000Z',
      voter: { eosId: VOTER_A_EOS, steamId64: null, name: 'AlphaVoter' },
      choice: 'yes',
    });
    const commands = assembler.onServerDown('2026-04-23T11:30:40.000Z');
    expect(commands).toHaveLength(1);
    expect(commands[0].result).toBe('cancelled');
    expect(commands[0].votesCollected).toBe(1);
    expect(commands[0].ballots).toHaveLength(1);
    expect(assembler.hasOpenVote()).toBe(false);
    expect(assembler.onServerDown('2026-04-23T11:31:00.000Z')).toHaveLength(0);
  });

  it('cancels a prior open vote when a new vote starts', () => {
    const assembler = new VoteAssembler(SERVER_ID);
    assembler.onVoteStart({
      ts: '2026-04-23T11:30:20.000Z',
      voteType: 'map_skip',
      initiator: null,
      mapCurrent: 'A_RAAS_v1',
      mapNext: null,
      mapTarget: null,
      votesRequired: 25,
    });
    const commands = assembler.onVoteStart({
      ts: '2026-04-23T11:35:20.000Z',
      voteType: 'map_change',
      initiator: null,
      mapCurrent: 'A_RAAS_v1',
      mapNext: null,
      mapTarget: 'B_AAS_v1',
      votesRequired: 30,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0].result).toBe('cancelled');
    expect(commands[0].voteType).toBe('map_skip');
    expect(assembler.hasOpenVote()).toBe(true);
  });
});

describe('LogIngestor vote wiring', () => {
  const startLine = `[2026.04.23-11.30.20:485][234]LogSquadVoteSystem: Display: Vote started: id=17 type=SkipMap initiator=[Online IDs: EOS: ${INITIATOR_EOS}] SkipGuy current=Yehorivka_RAAS_v1 next=Narva_AAS_v2 required=2`;
  const ballotYes = `[2026.04.23-11.30.25:000][240]LogSquadVoteSystem: Display: Vote registered: id=17 voter=[Online IDs: EOS: ${VOTER_A_EOS}] AlphaVoter choice=Yes`;
  const ballotNo = `[2026.04.23-11.30.26:000][241]LogSquadVoteSystem: Display: Vote registered: id=17 voter=[Online IDs: EOS: ${VOTER_B_EOS} steam: ${VOTER_STEAM}] BetaVoter choice=No`;
  const endLine =
    '[2026.04.23-11.31.00:000][300]LogSquadVoteSystem: Display: Vote finished: id=17 result=Passed votes=2/2';

  it('emits a single record command from a full start/ballot/end log sequence', () => {
    const commands: VoteRecordCommand[] = [];
    const ingestor = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      onVote: (command) => commands.push(command),
    });
    for (const line of [startLine, ballotYes, ballotNo, endLine]) ingestor.ingest(line);
    expect(commands).toHaveLength(1);
    const record = commands[0];
    expect(record.voteType).toBe('map_skip');
    expect(record.result).toBe('passed');
    expect(record.ballots).toHaveLength(2);
    expect(record.initiator?.eosId).toBe(INITIATOR_EOS);
  });

  it('cancels an open vote when a new world is brought up mid-vote', () => {
    const commands: VoteRecordCommand[] = [];
    const ingestor = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      onVote: (command) => commands.push(command),
    });
    ingestor.ingest(startLine);
    ingestor.ingest(ballotYes);
    ingestor.ingest(
      '[2026.04.23-11.30.50:000][260]LogWorld: Bringing World /Game/Maps/Narva/Gameplay_Layers/Narva_AAS_v2 up for play (max tick rate 50) at 2026.04.23-11.30.50',
    );
    expect(commands).toHaveLength(1);
    expect(commands[0].result).toBe('cancelled');
    expect(commands[0].ballots).toHaveLength(1);
  });

  it('cancels an open vote when the server process exits mid-vote', () => {
    const commands: VoteRecordCommand[] = [];
    const ingestor = new LogIngestor({
      serverId: SERVER_ID,
      beaconPort: 15000,
      onVote: (command) => commands.push(command),
    });
    ingestor.ingest(startLine);
    ingestor.ingest(
      '[2026.04.23-11.30.55:000][270]LogCore: FUnixPlatformMisc::RequestExit(bForce=false, ReturnCode=1)',
    );
    expect(commands).toHaveLength(1);
    expect(commands[0].result).toBe('cancelled');
  });
});
