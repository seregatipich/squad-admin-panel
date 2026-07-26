import { describe, expect, it, vi } from 'vitest';
import {
  type MapVoteCandidateEntry,
  type MapVoteServerEntry,
  type MapVoteTickDeps,
  runMapVoteTick,
} from '../src/map-vote-tick.js';

const SERVER_ID = '019f8000-0000-7000-8000-000000000001';
const MATCH_ID = '019f8000-0000-7000-8000-000000000002';
const PICK_ID = '019f8000-0000-7000-8000-000000000003';

function makeServer(overrides: Partial<MapVoteServerEntry> = {}): MapVoteServerEntry {
  return {
    serverId: SERVER_ID,
    selection: 'weighted_random',
    layerCooldown: 3,
    mapCooldown: 2,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<MapVoteCandidateEntry> = {}): MapVoteCandidateEntry {
  return {
    layer: 'Yehorivka RAAS v11',
    map: 'Yehorivka',
    weight: 1,
    enabled: true,
    deprecated: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MapVoteTickDeps> = {}): MapVoteTickDeps {
  return {
    loadEnabledServers: vi.fn().mockResolvedValue([makeServer()]),
    getLatestMatch: vi.fn().mockResolvedValue({ id: MATCH_ID }),
    hasPickForMatch: vi.fn().mockResolvedValue(false),
    loadCandidates: vi.fn().mockResolvedValue([makeCandidate()]),
    loadRecentMatches: vi.fn().mockResolvedValue([]),
    insertPick: vi.fn().mockResolvedValue(PICK_ID),
    markPickApplied: vi.fn().mockResolvedValue(undefined),
    setPickFailure: vi.fn().mockResolvedValue(undefined),
    isDepotUpdating: vi.fn().mockResolvedValue(false),
    sendRconCommand: vi.fn().mockResolvedValue(undefined),
    writeAuditEntry: vi.fn().mockResolvedValue(undefined),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('runMapVoteTick', () => {
  it('applies exactly one AdminSetNextLayer per new match', async () => {
    const deps = makeDeps();

    await expect(runMapVoteTick(deps)).resolves.toEqual({
      applied: 1,
      skippedDepotUpdate: 0,
      noCandidates: 0,
    });

    expect(deps.sendRconCommand).toHaveBeenCalledTimes(1);
    expect(deps.sendRconCommand).toHaveBeenCalledWith(
      { serverId: SERVER_ID, command: 'AdminSetNextLayer', args: ['Yehorivka RAAS v11'] },
      `map-vote:${MATCH_ID}`,
    );
    expect(deps.insertPick).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: SERVER_ID,
        matchId: MATCH_ID,
        layer: 'Yehorivka RAAS v11',
        selection: 'weighted_random',
        rngSeed: MATCH_ID,
      }),
    );
    expect(deps.markPickApplied).toHaveBeenCalledWith(PICK_ID);
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'server.map_vote.applied',
        targetType: 'server',
        targetId: SERVER_ID,
      }),
    );
  });

  it('does nothing when a pick already exists for the match', async () => {
    const deps = makeDeps({ hasPickForMatch: vi.fn().mockResolvedValue(true) });

    await expect(runMapVoteTick(deps)).resolves.toEqual({
      applied: 0,
      skippedDepotUpdate: 0,
      noCandidates: 0,
    });
    expect(deps.insertPick).not.toHaveBeenCalled();
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('skips the match when a concurrent tick wins the pick-row insert race', async () => {
    const deps = makeDeps({ insertPick: vi.fn().mockResolvedValue(null) });

    await expect(runMapVoteTick(deps)).resolves.toEqual({
      applied: 0,
      skippedDepotUpdate: 0,
      noCandidates: 0,
    });
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.markPickApplied).not.toHaveBeenCalled();
  });

  it('skips and audits during depot update', async () => {
    const deps = makeDeps({ isDepotUpdating: vi.fn().mockResolvedValue(true) });

    await expect(runMapVoteTick(deps)).resolves.toEqual({
      applied: 0,
      skippedDepotUpdate: 1,
      noCandidates: 0,
    });
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.setPickFailure).toHaveBeenCalledWith(PICK_ID, 'depot_update');
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'server.map_vote.skip_depot_update' }),
    );
  });

  it('audits no_candidates when pool is empty', async () => {
    const deps = makeDeps({ loadCandidates: vi.fn().mockResolvedValue([]) });

    await expect(runMapVoteTick(deps)).resolves.toEqual({
      applied: 0,
      skippedDepotUpdate: 0,
      noCandidates: 1,
    });
    expect(deps.insertPick).not.toHaveBeenCalled();
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'server.map_vote.no_candidates',
        targetId: SERVER_ID,
      }),
    );
  });

  it('does nothing for disabled servers', async () => {
    const deps = makeDeps({ loadEnabledServers: vi.fn().mockResolvedValue([]) });

    await expect(runMapVoteTick(deps)).resolves.toEqual({
      applied: 0,
      skippedDepotUpdate: 0,
      noCandidates: 0,
    });
    expect(deps.getLatestMatch).not.toHaveBeenCalled();
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
  });

  it('records the failure and continues when the RCON enqueue throws', async () => {
    const deps = makeDeps({
      sendRconCommand: vi.fn().mockRejectedValue(new Error('stream down')),
    });

    await expect(runMapVoteTick(deps)).resolves.toEqual({
      applied: 0,
      skippedDepotUpdate: 0,
      noCandidates: 0,
    });
    expect(deps.setPickFailure).toHaveBeenCalledWith(PICK_ID, 'rcon_enqueue_failed');
    expect(deps.markPickApplied).not.toHaveBeenCalled();
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'map_vote.rcon_failed', severity: 'error' }),
    );
  });

  it('skips a server that has no matches yet', async () => {
    const deps = makeDeps({ getLatestMatch: vi.fn().mockResolvedValue(null) });

    await expect(runMapVoteTick(deps)).resolves.toEqual({
      applied: 0,
      skippedDepotUpdate: 0,
      noCandidates: 0,
    });
    expect(deps.hasPickForMatch).not.toHaveBeenCalled();
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
  });
});
