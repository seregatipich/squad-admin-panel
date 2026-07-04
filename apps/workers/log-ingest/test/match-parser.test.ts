import { describe, expect, it } from 'vitest';
import {
  deriveGameMode,
  deriveIsSeed,
  deriveMap,
  MatchAssembler,
  type MatchCommand,
  parseNewGame,
  parseRoundTickets,
} from '../src/parser/match.js';

const SERVER_ID = '01903f7d-6a15-7c81-aa91-1e4fa9f9b7c5';

describe('parseNewGame', () => {
  it('extracts the layer classname from a Gameplay_Layers path', () => {
    const info = parseNewGame(
      'Bringing World /Game/Maps/Harju/Gameplay_Layers/Harju_RAAS_v1 up for play (max tick rate 50) at 2026.07.05',
    );
    expect(info).toEqual({ dlc: 'Game', mapClassname: 'Harju', layer: 'Harju_RAAS_v1' });
  });

  it('handles a DLC-prefixed layer without a nested layer folder', () => {
    const info = parseNewGame(
      'Bringing World /Game/Maps/CAF_Goose_Bay/CAF_Goose_Bay_AAS_v1 up for play',
    );
    expect(info?.layer).toBe('CAF_Goose_Bay_AAS_v1');
  });

  it('ignores the engine transition map', () => {
    expect(parseNewGame('Bringing World /Game/Maps/TransitionMap up for play')).toBeNull();
  });

  it('returns null for unrelated LogWorld messages', () => {
    expect(parseNewGame('Seamless travel to: /Game/Maps/Foo')).toBeNull();
  });
});

describe('parseRoundTickets', () => {
  it('parses the winning-team ticket line', () => {
    const info = parseRoundTickets(
      'Team 1, 7th Mechanized Brigade ( Russian Ground Forces ) has won the match with 342 Tickets on layer Harju RAAS v1',
    );
    expect(info).toEqual({
      team: 1,
      faction: 'Russian Ground Forces',
      outcome: 'won',
      tickets: 342,
      layer: 'Harju RAAS v1',
    });
  });

  it('parses the losing-team ticket line with a trailing period', () => {
    const info = parseRoundTickets(
      'Team 2, 1st Cavalry ( United States Army ) has lost the match with 0 Tickets on layer Harju RAAS v1.',
    );
    expect(info?.team).toBe(2);
    expect(info?.outcome).toBe('lost');
    expect(info?.tickets).toBe(0);
    expect(info?.faction).toBe('United States Army');
  });

  it('tolerates a faction without inner-paren spaces and no layer suffix', () => {
    const info = parseRoundTickets(
      'Team 1, 7th MB (Russian Ground Forces) has won the match with 1 Ticket',
    );
    expect(info?.faction).toBe('Russian Ground Forces');
    expect(info?.tickets).toBe(1);
    expect(info?.layer).toBe('');
  });

  it('returns null for non-ticket messages', () => {
    expect(parseRoundTickets('Match State Changed from InProgress to WaitingPostMatch')).toBeNull();
  });
});

describe('deriveGameMode', () => {
  it.each([
    ['Harju_RAAS_v1', 'RAAS'],
    ['CAF_Goose_Bay_AAS_v1', 'AAS'],
    ['Narva_Invasion_v2', 'Invasion'],
    ['Sumari_Seed_v1', 'Seed'],
    ['Yehorivka_TC_v1', 'TC'],
    ['Fallujah_Skirmish_v1', 'Skirmish'],
    ['Mutaha_FRAAS_v1', 'FRAAS'],
  ])('%s -> %s', (layer, mode) => {
    expect(deriveGameMode(layer)).toBe(mode);
  });

  it('returns null for an empty layer', () => {
    expect(deriveGameMode(null)).toBeNull();
    expect(deriveGameMode('')).toBeNull();
  });
});

describe('deriveMap', () => {
  it.each([
    ['Harju_RAAS_v1', 'Harju'],
    ['CAF_Goose_Bay_AAS_v1', 'CAF_Goose_Bay'],
    ['Al_Basrah_Invasion_v1', 'Al_Basrah'],
    ['Sumari_Seed_v1', 'Sumari'],
  ])('%s -> %s', (layer, map) => {
    expect(deriveMap(layer)).toBe(map);
  });
});

describe('deriveIsSeed', () => {
  it('is true for a Seed game mode regardless of online count', () => {
    expect(deriveIsSeed({ gameMode: 'Seed', onlineCount: 98, seedThreshold: 20 })).toBe(true);
  });

  it('is true when online count is below the threshold', () => {
    expect(deriveIsSeed({ gameMode: 'RAAS', onlineCount: 12, seedThreshold: 20 })).toBe(true);
  });

  it('is false for a populated non-seed round', () => {
    expect(deriveIsSeed({ gameMode: 'RAAS', onlineCount: 80, seedThreshold: 20 })).toBe(false);
  });

  it('is false when online count is unknown and mode is not seed', () => {
    expect(deriveIsSeed({ gameMode: 'AAS', onlineCount: null, seedThreshold: 20 })).toBe(false);
  });
});

describe('MatchAssembler', () => {
  const START = '2026-07-05T18:00:00.000Z';
  const END = '2026-07-05T18:45:00.000Z';

  it('opens a match on match.started carrying the pending layer', () => {
    const asm = new MatchAssembler(SERVER_ID);
    expect(asm.onNewGame('Harju_RAAS_v1', START)).toEqual([]);
    const commands = asm.onMatchStarted(START);
    expect(commands).toEqual([
      { kind: 'open', serverId: SERVER_ID, startedAt: START, layer: 'Harju_RAAS_v1' },
    ]);
    expect(asm.hasOpenMatch()).toBe(true);
  });

  it('closes a played round with both factions, tickets and winner', () => {
    const asm = new MatchAssembler(SERVER_ID);
    asm.onNewGame('Harju_RAAS_v1', START);
    asm.onMatchStarted(START);
    asm.onRoundTickets({
      team: 1,
      faction: 'Russian Ground Forces',
      outcome: 'won',
      tickets: 342,
      layer: 'Harju RAAS v1',
    });
    asm.onRoundTickets({
      team: 2,
      faction: 'United States Army',
      outcome: 'lost',
      tickets: 0,
      layer: 'Harju RAAS v1',
    });
    const commands = asm.onMatchEnded(END);
    expect(commands).toEqual<MatchCommand[]>([
      {
        kind: 'close',
        serverId: SERVER_ID,
        startedAt: START,
        endedAt: END,
        team1Faction: 'Russian Ground Forces',
        team2Faction: 'United States Army',
        team1Tickets: 342,
        team2Tickets: 0,
        winner: 'team1',
      },
    ]);
    expect(asm.hasOpenMatch()).toBe(false);
  });

  it('closes the open match as server_crashed on a server-down signal, winner null', () => {
    const asm = new MatchAssembler(SERVER_ID);
    asm.onNewGame('Yehorivka_RAAS_v1', START);
    asm.onMatchStarted(START);
    const commands = asm.onServerDown('server_crashed', END);
    expect(commands).toEqual<MatchCommand[]>([
      {
        kind: 'close_server_down',
        serverId: SERVER_ID,
        startedAt: START,
        endedAt: END,
        endReason: 'server_crashed',
      },
    ]);
    expect(asm.hasOpenMatch()).toBe(false);
  });

  it('emits no command on server-down when no match is open', () => {
    const asm = new MatchAssembler(SERVER_ID);
    expect(asm.onServerDown('server_crashed', END)).toEqual([]);
  });

  it('closes a stale open match as server_restarted when a new game starts', () => {
    const asm = new MatchAssembler(SERVER_ID);
    asm.onNewGame('Harju_RAAS_v1', START);
    asm.onMatchStarted(START);
    const nextStart = '2026-07-05T19:00:00.000Z';
    const commands = [
      ...asm.onNewGame('Narva_Invasion_v1', nextStart),
      ...asm.onMatchStarted(nextStart),
    ];
    expect(commands[0]).toEqual({
      kind: 'close_server_down',
      serverId: SERVER_ID,
      startedAt: START,
      endedAt: nextStart,
      endReason: 'server_restarted',
    });
    expect(commands[1]).toMatchObject({ kind: 'open', layer: 'Narva_Invasion_v1' });
  });

  it('resolves a draw when both teams report a loss', () => {
    const asm = new MatchAssembler(SERVER_ID);
    asm.onMatchStarted(START);
    asm.onRoundTickets({ team: 1, faction: 'A', outcome: 'lost', tickets: 5, layer: 'L' });
    asm.onRoundTickets({ team: 2, faction: 'B', outcome: 'lost', tickets: 5, layer: 'L' });
    const commands = asm.onMatchEnded(END);
    expect(commands[0]).toMatchObject({ kind: 'close', winner: 'draw' });
  });

  it('ignores ticket and end signals with no open match', () => {
    const asm = new MatchAssembler(SERVER_ID);
    expect(
      asm.onRoundTickets({ team: 1, faction: 'A', outcome: 'won', tickets: 1, layer: 'L' }),
    ).toEqual([]);
    expect(asm.onMatchEnded(END)).toEqual([]);
  });
});
