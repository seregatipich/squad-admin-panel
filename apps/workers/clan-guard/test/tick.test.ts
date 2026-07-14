import { describe, expect, it, vi } from 'vitest';
import {
  buildClanGuardMessage,
  type ClanGuardTickDeps,
  findImpostorMatch,
  matchProtectedTag,
  type OnlinePlayer,
  type ProtectedClan,
  runClanGuardTick,
} from '../src/tick.js';

const NOW = new Date('2026-07-14T12:00:00.000Z');

function makeClan(overrides: Partial<ProtectedClan> = {}): ProtectedClan {
  return {
    id: 'clan-1',
    name: 'Test Clan',
    tags: ['[TST]'],
    memberPlayerIds: new Set<string>(),
    ...overrides,
  };
}

function makePlayer(overrides: Partial<OnlinePlayer> = {}): OnlinePlayer {
  return {
    playerId: 'player-1',
    serverId: 'server-1',
    eosId: 'eos-1',
    name: '[TST] Impostor',
    connectedAt: new Date('2026-07-14T11:00:00.000Z'),
    hasPanelAccess: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ClanGuardTickDeps> = {}): ClanGuardTickDeps {
  return {
    now: NOW,
    loadSettings: vi.fn().mockResolvedValue({ enabled: true, gracePeriodSeconds: 300 }),
    loadProtectedClans: vi.fn().mockResolvedValue([makeClan()]),
    loadOnlinePlayers: vi.fn().mockResolvedValue([makePlayer()]),
    findLastWarn: vi.fn().mockResolvedValue(null),
    sendRconCommand: vi.fn().mockResolvedValue(undefined),
    recordModerationAction: vi.fn().mockResolvedValue(undefined),
    writeAuditEntry: vi.fn().mockResolvedValue(undefined),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('matchProtectedTag', () => {
  it('matches case-insensitive prefix when tag is stored wrapped', () => {
    expect(matchProtectedTag('[abc] Player', '[ABC]')).toBe(true);
  });

  it('does not match a non-prefix occurrence of the tag', () => {
    expect(matchProtectedTag('Player [ABC]', '[ABC]')).toBe(false);
  });

  it('matches a bare tag re-wrapped in brackets against a bracketed name', () => {
    expect(matchProtectedTag('[TST] Impostor', 'TST')).toBe(true);
  });

  it('does not match a bare tag occurring mid-name', () => {
    expect(matchProtectedTag('Some TST Player', 'TST')).toBe(false);
  });

  it('returns false for an empty tag', () => {
    expect(matchProtectedTag('[TST] Player', '')).toBe(false);
  });
});

describe('findImpostorMatch', () => {
  it('finds a match and skips clans the player is a member of', () => {
    const clans = [makeClan({ id: 'clan-1', tags: ['[TST]'], memberPlayerIds: new Set(['p1']) })];
    expect(findImpostorMatch('[TST] Member', clans, 'p1')).toBeNull();
    expect(findImpostorMatch('[TST] Impostor', clans, 'p2')).toEqual({
      clanId: 'clan-1',
      clanName: 'Test Clan',
      tag: '[TST]',
    });
  });
});

describe('buildClanGuardMessage', () => {
  it('builds a single-line Russian message with no CR/LF', () => {
    const message = buildClanGuardMessage('[TST]', 'Test Clan');
    expect(message).toBe('Тег [TST] защищён кланом Test Clan. Смените ник.');
    expect(message).not.toMatch(/[\r\n]/);
  });
});

describe('runClanGuardTick', () => {
  it('kill-switch: enabled=false skips the tick with no further queries or RCON', async () => {
    const deps = makeDeps({
      loadSettings: vi.fn().mockResolvedValue({ enabled: false, gracePeriodSeconds: 300 }),
    });
    const result = await runClanGuardTick(deps);
    expect(result).toEqual({ skipped: true, warned: 0, kicked: 0, errors: 0 });
    expect(deps.loadProtectedClans).not.toHaveBeenCalled();
    expect(deps.loadOnlinePlayers).not.toHaveBeenCalled();
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clan_guard.skipped_disabled' }),
    );
  });

  it('first detection: warns exactly once and records a moderation_actions warn row, no kick', async () => {
    const deps = makeDeps();
    const result = await runClanGuardTick(deps);
    expect(result).toEqual({ skipped: false, warned: 1, kicked: 0, errors: 0 });
    expect(deps.sendRconCommand).toHaveBeenCalledTimes(1);
    expect(deps.sendRconCommand).toHaveBeenCalledWith({
      serverId: 'server-1',
      command: 'AdminWarn',
      args: ['eos-1', 'Тег [TST] защищён кланом Test Clan. Смените ник.'],
    });
    expect(deps.recordModerationAction).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'warn', clanId: 'clan-1', tag: '[TST]' }),
    );
    expect(deps.sendRconCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'AdminKick' }),
    );
  });

  it('warn older than grace: kicks and records phase kick + audit entry', async () => {
    const lastWarnAt = new Date('2026-07-14T11:54:00.000Z'); // 6 min before NOW
    const deps = makeDeps({ findLastWarn: vi.fn().mockResolvedValue({ createdAt: lastWarnAt }) });
    const result = await runClanGuardTick(deps);
    expect(result).toEqual({ skipped: false, warned: 0, kicked: 1, errors: 0 });
    expect(deps.sendRconCommand).toHaveBeenCalledWith({
      serverId: 'server-1',
      command: 'AdminKick',
      args: ['eos-1', 'Тег [TST] защищён кланом Test Clan. Смените ник.'],
    });
    expect(deps.recordModerationAction).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'kick' }),
    );
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 'player-1', clanId: 'clan-1' }),
    );
  });

  it('warn younger than grace: no kick, no duplicate warn', async () => {
    const lastWarnAt = new Date('2026-07-14T11:58:00.000Z'); // 2 min before NOW, grace=300s
    const deps = makeDeps({ findLastWarn: vi.fn().mockResolvedValue({ createdAt: lastWarnAt }) });
    const result = await runClanGuardTick(deps);
    expect(result).toEqual({ skipped: false, warned: 0, kicked: 0, errors: 0 });
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.recordModerationAction).not.toHaveBeenCalled();
  });

  it('clan member wearing their own clan tag is left untouched', async () => {
    const deps = makeDeps({
      loadProtectedClans: vi
        .fn()
        .mockResolvedValue([makeClan({ memberPlayerIds: new Set(['player-1']) })]),
    });
    const result = await runClanGuardTick(deps);
    expect(result).toEqual({ skipped: false, warned: 0, kicked: 0, errors: 0 });
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.recordModerationAction).not.toHaveBeenCalled();
  });

  it('panel_access holder past grace is re-warned, never kicked, no duplicate ledger row', async () => {
    const lastWarnAt = new Date('2026-07-14T11:54:00.000Z');
    const deps = makeDeps({
      loadOnlinePlayers: vi.fn().mockResolvedValue([makePlayer({ hasPanelAccess: true })]),
      findLastWarn: vi.fn().mockResolvedValue({ createdAt: lastWarnAt }),
    });
    const result = await runClanGuardTick(deps);
    expect(result).toEqual({ skipped: false, warned: 1, kicked: 0, errors: 0 });
    expect(deps.sendRconCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'AdminWarn' }),
    );
    expect(deps.sendRconCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'AdminKick' }),
    );
    expect(deps.recordModerationAction).not.toHaveBeenCalled();
  });

  it('clan with is_tag_protected=false is ignored (not in loadProtectedClans result)', async () => {
    const deps = makeDeps({ loadProtectedClans: vi.fn().mockResolvedValue([]) });
    const result = await runClanGuardTick(deps);
    expect(result).toEqual({ skipped: false, warned: 0, kicked: 0, errors: 0 });
    expect(deps.loadOnlinePlayers).not.toHaveBeenCalled();
  });

  it('skips a player with null eosId without throwing', async () => {
    const deps = makeDeps({
      loadOnlinePlayers: vi.fn().mockResolvedValue([makePlayer({ eosId: null })]),
    });
    const result = await runClanGuardTick(deps);
    expect(result).toEqual({ skipped: false, warned: 0, kicked: 0, errors: 0 });
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
  });

  it('an RCON failure on one player does not abort processing of the rest', async () => {
    const deps = makeDeps({
      loadOnlinePlayers: vi
        .fn()
        .mockResolvedValue([
          makePlayer({ playerId: 'player-1', eosId: 'eos-1' }),
          makePlayer({ playerId: 'player-2', eosId: 'eos-2', name: '[TST] Second' }),
        ]),
      sendRconCommand: vi
        .fn()
        .mockRejectedValueOnce(new Error('rcon down'))
        .mockResolvedValueOnce(undefined),
    });
    const result = await runClanGuardTick(deps);
    expect(result).toEqual({ skipped: false, warned: 1, kicked: 0, errors: 1 });
    expect(deps.sendRconCommand).toHaveBeenCalledTimes(2);
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'clan_guard.player_failed' }),
    );
  });

  it('calls findLastWarn scoped by the session connectedAt (rejoin restarts the cycle)', async () => {
    const connectedAt = new Date('2026-07-14T11:30:00.000Z');
    const deps = makeDeps({
      loadOnlinePlayers: vi.fn().mockResolvedValue([makePlayer({ connectedAt })]),
    });
    await runClanGuardTick(deps);
    expect(deps.findLastWarn).toHaveBeenCalledWith('player-1', 'server-1', connectedAt);
  });
});
