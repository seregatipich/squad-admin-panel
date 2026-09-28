import { describe, expect, it, vi } from 'vitest';
import {
  type RotationScheduleEntry,
  type RotationScheduleTickDeps,
  resolveDueRotationSchedule,
  runRotationScheduleTick,
} from '../src/rotation-schedule-tick.js';

function makeEntry(overrides: Partial<RotationScheduleEntry> = {}): RotationScheduleEntry {
  return {
    id: '019f7800-0000-7000-8000-000000000001',
    serverId: '019f7800-0000-7000-8000-000000000002',
    scheduledAt: new Date('2026-07-13T10:00:00.000Z'),
    layer: 'Yehorivka RAAS v11',
    mode: 'set_next',
    lastExecutedAt: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<RotationScheduleTickDeps> = {}): RotationScheduleTickDeps {
  return {
    loadEnabledEntries: vi.fn().mockResolvedValue([]),
    isDepotUpdating: vi.fn().mockResolvedValue(false),
    sendRconCommand: vi.fn().mockResolvedValue(undefined),
    setLastExecutedAt: vi.fn().mockResolvedValue(undefined),
    writeAuditEntry: vi.fn().mockResolvedValue(undefined),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('resolveDueRotationSchedule', () => {
  it('returns a due one-off occurrence once the scheduled time has passed', () => {
    const entry = makeEntry();
    expect(resolveDueRotationSchedule(entry, new Date('2026-07-13T10:01:00.000Z'))).toEqual(
      entry.scheduledAt,
    );
  });

  it('does not repeat an executed entry or fire one early', () => {
    const entry = makeEntry();
    expect(resolveDueRotationSchedule(entry, new Date('2026-07-13T09:59:00.000Z'))).toBeNull();
    expect(
      resolveDueRotationSchedule(
        { ...entry, lastExecutedAt: entry.scheduledAt },
        new Date('2026-07-13T12:00:00.000Z'),
      ),
    ).toBeNull();
  });
});

describe('runRotationScheduleTick', () => {
  it('queues AdminSetNextLayer and audits successful execution', async () => {
    const entry = makeEntry();
    const deps = makeDeps({
      now: new Date('2026-07-13T10:00:05.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
    });

    await expect(runRotationScheduleTick(deps)).resolves.toEqual({
      executed: 1,
      skippedDepotUpdate: 0,
    });
    expect(deps.sendRconCommand).toHaveBeenCalledWith({
      serverId: entry.serverId,
      command: 'AdminSetNextLayer',
      args: [entry.layer],
    });
    expect(deps.setLastExecutedAt).toHaveBeenCalledWith(entry.id, entry.scheduledAt);
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'server.rotation_schedule.execute' }),
    );
  });

  it('uses AdminChangeLayer for force_change entries', async () => {
    const entry = makeEntry({ mode: 'force_change' });
    const deps = makeDeps({
      now: new Date('2026-07-13T10:00:05.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
    });

    await runRotationScheduleTick(deps);

    expect(deps.sendRconCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'AdminChangeLayer' }),
    );
  });

  it('skips a one-off entry more than 15 minutes late instead of firing it (#1004)', async () => {
    const entry = makeEntry();
    const deps = makeDeps({
      // 20 minutes after scheduledAt — as if the worker was down and just recovered.
      now: new Date('2026-07-13T10:20:00.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
    });

    await expect(runRotationScheduleTick(deps)).resolves.toEqual({
      executed: 0,
      skippedDepotUpdate: 0,
    });
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    // The cursor still advances, so the entry does not retry forever.
    expect(deps.setLastExecutedAt).toHaveBeenCalledWith(entry.id, entry.scheduledAt);
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'server.rotation_schedule.skip_expired' }),
    );
  });

  it('still fires an entry inside the 15-minute lateness window', async () => {
    const entry = makeEntry();
    const deps = makeDeps({
      now: new Date('2026-07-13T10:14:00.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
    });

    await expect(runRotationScheduleTick(deps)).resolves.toEqual({
      executed: 1,
      skippedDepotUpdate: 0,
    });
    expect(deps.sendRconCommand).toHaveBeenCalled();
  });

  it('does not advance a schedule while a depot update is active', async () => {
    const entry = makeEntry();
    const deps = makeDeps({
      now: new Date('2026-07-13T10:00:05.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
      isDepotUpdating: vi.fn().mockResolvedValue(true),
    });

    await expect(runRotationScheduleTick(deps)).resolves.toEqual({
      executed: 0,
      skippedDepotUpdate: 1,
    });
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.setLastExecutedAt).not.toHaveBeenCalled();
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'server.rotation_schedule.skip_depot_update' }),
    );
  });
});
