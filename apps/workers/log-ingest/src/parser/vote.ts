/**
 * Squad built-in vote parsing + assembly (VOTE-1).
 *
 * Squad's native vote subsystem (map skip / map change / admin-initiated) writes
 * a start line, one line per ballot, and an end line to SquadGame.log under the
 * `LogSquadVoteSystem` category. The exact wire grammar is pinned in
 * `ai_docs/research/vote-log-format.md`; live capture against a real host is
 * env-gated, so the three regex constants below are the single place to adjust
 * once validated. Everything downstream (assembler, store, schema) is
 * format-independent.
 *
 * The pure functions here are deterministic and unit-tested with synthetic
 * fixtures. `VoteAssembler` is a per-server state machine that accumulates a
 * vote in memory and emits exactly one terminal `record` command on end or on a
 * server-down, so a restart mid-vote yields a `cancelled` row rather than a
 * dangling open row.
 */
import type { LogLine } from './patterns.js';

export const VOTE_CATEGORY = 'LogSquadVoteSystem';

export type VoteType = 'map_skip' | 'map_change' | 'admin';
export type VoteChoice = 'yes' | 'no';
export type VoteResult = 'passed' | 'failed' | 'cancelled';

export interface VoteIdentity {
  eosId: string | null;
  steamId64: string | null;
  name: string;
}

export interface ParsedVoteStart {
  ts: string;
  voteType: VoteType;
  initiator: VoteIdentity | null;
  mapCurrent: string | null;
  mapNext: string | null;
  mapTarget: string | null;
  votesRequired: number;
}

export interface ParsedVoteBallot {
  ts: string;
  voter: VoteIdentity;
  choice: VoteChoice;
}

export interface ParsedVoteEnd {
  ts: string;
  result: Exclude<VoteResult, 'cancelled'>;
  votesCollected: number;
  votesRequired: number;
}

const IDS = /\[Online IDs:\s*EOS:\s*(?<eos>[0-9a-f]{32})(?:\s+steam:\s*(?<steam>\d{17}))?\s*\]/i;

const VOTE_START =
  /^Vote started:\s*(?:id=\S+\s+)?type=(?<type>\w+)\s+initiator=(?<initiator>.+?)\s+current=(?<current>\S+)(?:\s+next=(?<next>\S+))?(?:\s+target=(?<target>\S+))?\s+required=(?<required>\d+)\s*$/;

const VOTE_BALLOT =
  /^Vote registered:\s*(?:id=\S+\s+)?voter=(?<voter>.+?)\s+choice=(?<choice>Yes|No)\s*$/i;

const VOTE_END =
  /^Vote finished:\s*(?:id=\S+\s+)?result=(?<result>Passed|Failed)\s+votes=(?<collected>\d+)\/(?<required>\d+)\s*$/i;

const OPTIONAL_LAYER = new Set(['none', 'null', '']);

function mapVoteType(raw: string): VoteType | null {
  const key = raw.toLowerCase();
  if (key === 'skipmap' || key === 'skip' || key === 'mapskip') return 'map_skip';
  if (key === 'changelayer' || key === 'mapchange' || key === 'changemap') return 'map_change';
  if (key === 'admin' || key === 'adminvote') return 'admin';
  return null;
}

function normalizeLayer(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (OPTIONAL_LAYER.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function parseIdentity(segment: string): VoteIdentity {
  const ids = IDS.exec(segment);
  if (ids?.groups) {
    const name = segment.replace(IDS, '').trim();
    return {
      eosId: ids.groups.eos ? ids.groups.eos.toLowerCase() : null,
      steamId64: ids.groups.steam ?? null,
      name,
    };
  }
  return { eosId: null, steamId64: null, name: segment.trim() };
}

function isVoteLine(parsed: LogLine): boolean {
  return parsed.category === VOTE_CATEGORY;
}

export function parseVoteStart(parsed: LogLine): ParsedVoteStart | null {
  if (!isVoteLine(parsed)) return null;
  const match = VOTE_START.exec(parsed.message);
  if (!match?.groups) return null;
  const voteType = mapVoteType(match.groups.type ?? '');
  if (!voteType) return null;
  return {
    ts: parsed.ts.toISOString(),
    voteType,
    initiator: parseIdentity(match.groups.initiator ?? ''),
    mapCurrent: normalizeLayer(match.groups.current),
    mapNext: normalizeLayer(match.groups.next),
    mapTarget: normalizeLayer(match.groups.target),
    votesRequired: Number(match.groups.required),
  };
}

export function parseVoteBallot(parsed: LogLine): ParsedVoteBallot | null {
  if (!isVoteLine(parsed)) return null;
  const match = VOTE_BALLOT.exec(parsed.message);
  if (!match?.groups) return null;
  return {
    ts: parsed.ts.toISOString(),
    voter: parseIdentity(match.groups.voter ?? ''),
    choice: (match.groups.choice as string).toLowerCase() === 'yes' ? 'yes' : 'no',
  };
}

export function parseVoteEnd(parsed: LogLine): ParsedVoteEnd | null {
  if (!isVoteLine(parsed)) return null;
  const match = VOTE_END.exec(parsed.message);
  if (!match?.groups) return null;
  return {
    ts: parsed.ts.toISOString(),
    result: (match.groups.result as string).toLowerCase() === 'passed' ? 'passed' : 'failed',
    votesCollected: Number(match.groups.collected),
    votesRequired: Number(match.groups.required),
  };
}

export interface VoteBallotRecord {
  voter: VoteIdentity;
  choice: VoteChoice;
  votedAt: string;
}

export interface VoteRecordCommand {
  kind: 'record';
  serverId: string;
  voteType: VoteType;
  initiator: VoteIdentity | null;
  mapCurrent: string | null;
  mapNext: string | null;
  mapTarget: string | null;
  votesCollected: number;
  votesRequired: number;
  result: VoteResult;
  startedAt: string;
  endedAt: string;
  ballots: VoteBallotRecord[];
}

interface OpenVote {
  startedAt: string;
  voteType: VoteType;
  initiator: VoteIdentity | null;
  mapCurrent: string | null;
  mapNext: string | null;
  mapTarget: string | null;
  votesRequired: number;
  ballots: Map<string, VoteBallotRecord>;
}

function ballotKey(voter: VoteIdentity): string {
  if (voter.eosId) return `eos:${voter.eosId}`;
  if (voter.steamId64) return `steam:${voter.steamId64}`;
  return `name:${voter.name.trim().toLowerCase()}`;
}

/**
 * Per-server vote state machine. One instance per observed server. Accumulates
 * a single in-flight vote and emits one terminal `record` command on end or on
 * a server-down.
 */
export class VoteAssembler {
  private open: OpenVote | null = null;

  constructor(private readonly serverId: string) {}

  hasOpenVote(): boolean {
    return this.open !== null;
  }

  onVoteStart(start: ParsedVoteStart): VoteRecordCommand[] {
    const commands: VoteRecordCommand[] = [];
    if (this.open) {
      commands.push(this.buildCancelled(start.ts));
    }
    this.open = {
      startedAt: start.ts,
      voteType: start.voteType,
      initiator: start.initiator,
      mapCurrent: start.mapCurrent,
      mapNext: start.mapNext,
      mapTarget: start.mapTarget,
      votesRequired: start.votesRequired,
      ballots: new Map(),
    };
    return commands;
  }

  onVoteBallot(ballot: ParsedVoteBallot): VoteRecordCommand[] {
    if (!this.open) return [];
    this.open.ballots.set(ballotKey(ballot.voter), {
      voter: ballot.voter,
      choice: ballot.choice,
      votedAt: ballot.ts,
    });
    return [];
  }

  onVoteEnd(end: ParsedVoteEnd): VoteRecordCommand[] {
    if (!this.open) return [];
    const ballots = [...this.open.ballots.values()];
    const yesCount = ballots.filter((ballot) => ballot.choice === 'yes').length;
    const command: VoteRecordCommand = {
      kind: 'record',
      serverId: this.serverId,
      voteType: this.open.voteType,
      initiator: this.open.initiator,
      mapCurrent: this.open.mapCurrent,
      mapNext: this.open.mapNext,
      mapTarget: this.open.mapTarget,
      votesCollected: Number.isFinite(end.votesCollected) ? end.votesCollected : yesCount,
      votesRequired: end.votesRequired || this.open.votesRequired,
      result: end.result,
      startedAt: this.open.startedAt,
      endedAt: end.ts,
      ballots,
    };
    this.open = null;
    return [command];
  }

  onServerDown(ts: string): VoteRecordCommand[] {
    if (!this.open) return [];
    const command = this.buildCancelled(ts);
    this.open = null;
    return [command];
  }

  private buildCancelled(ts: string): VoteRecordCommand {
    const openVote = this.open as OpenVote;
    const ballots = [...openVote.ballots.values()];
    const yesCount = ballots.filter((ballot) => ballot.choice === 'yes').length;
    return {
      kind: 'record',
      serverId: this.serverId,
      voteType: openVote.voteType,
      initiator: openVote.initiator,
      mapCurrent: openVote.mapCurrent,
      mapNext: openVote.mapNext,
      mapTarget: openVote.mapTarget,
      votesCollected: yesCount,
      votesRequired: openVote.votesRequired,
      result: 'cancelled',
      startedAt: openVote.startedAt,
      endedAt: ts,
      ballots,
    };
  }
}
