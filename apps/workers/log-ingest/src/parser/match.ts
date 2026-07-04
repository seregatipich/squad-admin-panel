/**
 * Match assembly primitives (MATCH-1).
 *
 * Squad emits round lifecycle across several log lines that the base ingestor
 * does not surface as events:
 *
 *   LogWorld: Bringing World /Game/Maps/Harju/Gameplay_Layers/Harju_RAAS_v1 up for play ...
 *   LogGameState: Match State Changed from WaitingToStart to InProgress
 *   LogSquadGameEvents: Display: Team 1, 7th MB ( Russian Ground Forces ) has won the match with 342 Tickets on layer Harju RAAS v1
 *   LogSquadGameEvents: Display: Team 2, 1st Cav ( United States Army ) has lost the match with 0 Tickets on layer Harju RAAS v1
 *   LogGameState: Match State Changed from InProgress to WaitingPostMatch
 *
 * The regexes mirror SquadJS log-parser rules (`new-game`, `round-tickets`).
 * The exact wire format is env-gated against a live Squad host; the pure
 * functions here are deterministic and unit-tested with synthetic fixtures.
 */

export interface NewGameInfo {
  dlc: string;
  mapClassname: string;
  layer: string;
}

const NEW_GAME =
  /^Bringing World \/([A-Za-z0-9_-]+)\/(?:Maps\/)?([A-Za-z0-9_-]+)\/(?:.+\/)?([A-Za-z0-9_-]+?)(?:\.[A-Za-z0-9_-]+)?(?: up for play|$)/;

export function parseNewGame(message: string): NewGameInfo | null {
  const match = NEW_GAME.exec(message);
  if (!match) return null;
  const layer = match[3] as string;
  if (/transition/i.test(layer) || /transition/i.test(match[2] as string)) return null;
  return {
    dlc: match[1] as string,
    mapClassname: match[2] as string,
    layer,
  };
}

export interface RoundTicketsInfo {
  team: 1 | 2;
  faction: string;
  tickets: number;
  outcome: 'won' | 'lost';
  layer: string;
}

const ROUND_TICKETS =
  /^Team ([12]), (.+?) \(\s*(.+?)\s*\) has (won|lost) the match with (\d+) Tickets?(?: on layer (.+?))?\.?$/;

export function parseRoundTickets(message: string): RoundTicketsInfo | null {
  const match = ROUND_TICKETS.exec(message);
  if (!match) return null;
  return {
    team: Number(match[1]) as 1 | 2,
    faction: (match[3] as string).trim(),
    outcome: match[4] as 'won' | 'lost',
    tickets: Number(match[5]),
    layer: (match[6] ?? '').trim(),
  };
}

const MODE_CANONICAL: Record<string, string> = {
  fraas: 'FRAAS',
  raas: 'RAAS',
  aas: 'AAS',
  invasion: 'Invasion',
  skirmish: 'Skirmish',
  seed: 'Seed',
  tc: 'TC',
  insurgency: 'Insurgency',
  destruction: 'Destruction',
  demolition: 'Demolition',
  training: 'Training',
  tutorial: 'Tutorial',
  tanks: 'Tanks',
};

const canonicalMode = (segment: string): string | null =>
  MODE_CANONICAL[segment.toLowerCase()] ?? null;

const isVersionSegment = (segment: string): boolean => /^v\d+/i.test(segment);

export function deriveGameMode(layer: string | null): string | null {
  if (!layer) return null;
  const segments = layer.split('_').filter(Boolean);
  if (segments.length === 0) return null;

  const last = segments[segments.length - 1] as string;
  if (isVersionSegment(last) && segments.length >= 2) {
    const beforeVersion = segments[segments.length - 2] as string;
    const canon = canonicalMode(beforeVersion);
    if (canon) return canon;
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    const canon = canonicalMode(segments[i] as string);
    if (canon) return canon;
  }
  if (isVersionSegment(last) && segments.length >= 2) {
    return segments[segments.length - 2] as string;
  }
  return null;
}

export function deriveMap(layer: string | null): string | null {
  if (!layer) return null;
  const segments = layer.split('_').filter(Boolean);
  if (segments.length === 0) return null;

  let end = segments.length;
  if (isVersionSegment(segments[end - 1] as string)) end -= 1;
  if (end <= 1) return null;

  let modeIndex = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (canonicalMode(segments[i] as string)) {
      modeIndex = i;
      break;
    }
  }
  if (modeIndex === -1) modeIndex = end - 1;

  const mapSegments = segments.slice(0, modeIndex);
  if (mapSegments.length === 0) return null;
  return mapSegments.join('_');
}

export function deriveIsSeed(params: {
  gameMode: string | null;
  onlineCount: number | null;
  seedThreshold: number;
}): boolean {
  if (params.gameMode && params.gameMode.toLowerCase() === 'seed') return true;
  if (params.onlineCount !== null && params.onlineCount < params.seedThreshold) return true;
  return false;
}

export type MatchWinner = 'team1' | 'team2' | 'draw';

export type MatchCommand =
  | { kind: 'open'; serverId: string; startedAt: string; layer: string | null }
  | {
      kind: 'close';
      serverId: string;
      startedAt: string;
      endedAt: string;
      team1Faction: string | null;
      team2Faction: string | null;
      team1Tickets: number | null;
      team2Tickets: number | null;
      winner: MatchWinner | null;
    }
  | {
      kind: 'close_server_down';
      serverId: string;
      startedAt: string | null;
      endedAt: string;
      endReason: 'server_crashed' | 'server_restarted';
    };

interface TeamResult {
  faction: string | null;
  tickets: number | null;
  outcome: 'won' | 'lost' | null;
}

/**
 * Pure per-server state machine assembling `matches` lifecycle commands from
 * ordered log signals. One instance per observed server.
 */
export class MatchAssembler {
  private pendingLayer: string | null = null;
  private open: { startedAt: string; layer: string | null } | null = null;
  private team1: TeamResult = { faction: null, tickets: null, outcome: null };
  private team2: TeamResult = { faction: null, tickets: null, outcome: null };

  constructor(private readonly serverId: string) {}

  hasOpenMatch(): boolean {
    return this.open !== null;
  }

  onNewGame(layer: string | null, ts: string): MatchCommand[] {
    const commands: MatchCommand[] = [];
    if (this.open) {
      commands.push(this.buildServerDown('server_restarted', ts));
      this.reset();
    }
    this.pendingLayer = layer;
    return commands;
  }

  onMatchStarted(ts: string): MatchCommand[] {
    const commands: MatchCommand[] = [];
    if (this.open) {
      commands.push(this.buildServerDown('server_restarted', ts));
      this.reset();
    }
    this.open = { startedAt: ts, layer: this.pendingLayer };
    const layer = this.pendingLayer;
    this.pendingLayer = null;
    this.resetTeams();
    commands.push({ kind: 'open', serverId: this.serverId, startedAt: ts, layer });
    return commands;
  }

  onRoundTickets(info: RoundTicketsInfo): MatchCommand[] {
    if (!this.open) return [];
    const target = info.team === 1 ? this.team1 : this.team2;
    target.faction = info.faction;
    target.tickets = info.tickets;
    target.outcome = info.outcome;
    if (!this.open.layer && info.layer) this.open.layer = info.layer;
    return [];
  }

  onMatchEnded(ts: string): MatchCommand[] {
    if (!this.open) return [];
    const startedAt = this.open.startedAt;
    const winner = this.resolveWinner();
    const command: MatchCommand = {
      kind: 'close',
      serverId: this.serverId,
      startedAt,
      endedAt: ts,
      team1Faction: this.team1.faction,
      team2Faction: this.team2.faction,
      team1Tickets: this.team1.tickets,
      team2Tickets: this.team2.tickets,
      winner,
    };
    this.reset();
    return [command];
  }

  onServerDown(reason: 'server_crashed' | 'server_restarted', ts: string): MatchCommand[] {
    if (!this.open) return [];
    const command = this.buildServerDown(reason, ts);
    this.reset();
    return [command];
  }

  private buildServerDown(reason: 'server_crashed' | 'server_restarted', ts: string): MatchCommand {
    return {
      kind: 'close_server_down',
      serverId: this.serverId,
      startedAt: this.open?.startedAt ?? null,
      endedAt: ts,
      endReason: reason,
    };
  }

  private resolveWinner(): MatchWinner | null {
    if (this.team1.outcome === 'won') return 'team1';
    if (this.team2.outcome === 'won') return 'team2';
    if (this.team1.outcome === 'lost' && this.team2.outcome === 'lost') return 'draw';
    return null;
  }

  private resetTeams(): void {
    this.team1 = { faction: null, tickets: null, outcome: null };
    this.team2 = { faction: null, tickets: null, outcome: null };
  }

  private reset(): void {
    this.open = null;
    this.pendingLayer = null;
    this.resetTeams();
  }
}
