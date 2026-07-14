import { describe, expect, it, vi } from 'vitest';
import {
  resolveDueOccurrence,
  runSeedScheduleTick,
  type SeedScheduleEntry,
  type SeedScheduleTickDeps,
} from '../src/seed-schedule-tick.js';

function makeEntry(overrides: Partial<SeedScheduleEntry> = {}): SeedScheduleEntry {
  return {
    id: '019f46a1-0000-7000-8000-000000000001',
    serverId: '019f46a1-0000-7000-8000-000000000099',
    startsAt: new Date('2026-07-11T10:00:00.000Z'),
    seedLayer: 'Sumari Seed v1',
    broadcastText: null,
    recurrence: null,
    lastExecutedAt: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SeedScheduleTickDeps> = {}): SeedScheduleTickDeps {
  return {
    loadEnabledEntries: vi.fn().mockResolvedValue([]),
    isDepotUpdating: vi.fn().mockResolvedValue(false),
    getSeedingLiveness: vi.fn().mockResolvedValue('unknown'),
    sendRconCommand: vi.fn().mockResolvedValue(undefined),
    setLastExecutedAt: vi.fn().mockResolvedValue(undefined),
    writeAuditEntry: vi.fn().mockResolvedValue(undefined),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('resolveDueOccurrence', () => {
  it('is due for a one-off entry once starts_at <= now and never executed', () => {
    const entry = makeEntry({ startsAt: new Date('2026-07-11T10:00:00.000Z') });
    expect(resolveDueOccurrence(entry, new Date('2026-07-11T10:00:01.000Z'))).toEqual(
      entry.startsAt,
    );
  });

  it('is not due for a one-off entry before starts_at', () => {
    const entry = makeEntry({ startsAt: new Date('2026-07-11T10:00:00.000Z') });
    expect(resolveDueOccurrence(entry, new Date('2026-07-11T09:59:00.000Z'))).toBeNull();
  });

  it('is never due again for a one-off entry once last_executed_at is set', () => {
    const entry = makeEntry({
      startsAt: new Date('2026-07-11T10:00:00.000Z'),
      lastExecutedAt: new Date('2026-07-11T10:00:00.000Z'),
    });
    expect(resolveDueOccurrence(entry, new Date('2026-07-12T10:00:00.000Z'))).toBeNull();
  });

  it('is not due for a disabled/not-yet-due recurring entry outside its window', () => {
    const entry = makeEntry({
      recurrence: '0 10 * * 6', // every Saturday 10:00 UTC
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
    });
    // 2026-07-11 10:00 UTC is a Saturday, but "now" is before it.
    expect(resolveDueOccurrence(entry, new Date('2026-07-11T09:00:00.000Z'))).toBeNull();
  });

  it('fires a recurring entry for a cron occurrence after last_executed_at', () => {
    const entry = makeEntry({
      recurrence: '0 10 * * 6',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      lastExecutedAt: null,
    });
    const occurrence = resolveDueOccurrence(entry, new Date('2026-07-11T10:05:00.000Z'));
    expect(occurrence).toEqual(new Date('2026-07-11T10:00:00.000Z'));
  });

  it('does not re-fire the same recurring occurrence once last_executed_at is advanced past it', () => {
    const entry = makeEntry({
      recurrence: '0 10 * * 6',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      lastExecutedAt: new Date('2026-07-11T10:00:00.000Z'),
    });
    expect(resolveDueOccurrence(entry, new Date('2026-07-11T10:30:00.000Z'))).toBeNull();
  });
});

describe('runSeedScheduleTick', () => {
  it('fires AdminSetNextLayer for a due one-off entry when the server is live, and sets last_executed_at', async () => {
    const entry = makeEntry({ startsAt: new Date('2026-07-11T10:00:00.000Z') });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
      getSeedingLiveness: vi.fn().mockResolvedValue('live'),
    });

    const result = await runSeedScheduleTick(deps);

    expect(result).toEqual({ executed: 1, skippedDepotUpdate: 0 });
    expect(deps.sendRconCommand).toHaveBeenCalledWith({
      serverId: entry.serverId,
      command: 'AdminSetNextLayer',
      args: [entry.seedLayer],
    });
    expect(deps.setLastExecutedAt).toHaveBeenCalledWith(entry.id, entry.startsAt);
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'system', label: 'seed-scheduler' },
        actionType: 'server.seed_schedule.execute',
        targetType: 'seed_schedule',
        targetId: entry.id,
      }),
    );
  });

  it('fires AdminChangeLayer when the server state is seeding', async () => {
    const entry = makeEntry({ startsAt: new Date('2026-07-11T10:00:00.000Z') });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
      getSeedingLiveness: vi.fn().mockResolvedValue('seeding'),
    });

    await runSeedScheduleTick(deps);

    expect(deps.sendRconCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'AdminChangeLayer' }),
    );
  });

  it('fires AdminChangeLayer when the server state is unknown (no SEED-1 redis key yet)', async () => {
    const entry = makeEntry({ startsAt: new Date('2026-07-11T10:00:00.000Z') });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
      getSeedingLiveness: vi.fn().mockResolvedValue('unknown'),
    });

    await runSeedScheduleTick(deps);

    expect(deps.sendRconCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'AdminChangeLayer' }),
    );
  });

  it('also sends AdminBroadcast when broadcast_text is set', async () => {
    const entry = makeEntry({
      startsAt: new Date('2026-07-11T10:00:00.000Z'),
      broadcastText: 'Заходим сидить!',
    });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
      getSeedingLiveness: vi.fn().mockResolvedValue('live'),
    });

    await runSeedScheduleTick(deps);

    expect(deps.sendRconCommand).toHaveBeenCalledTimes(2);
    expect(deps.sendRconCommand).toHaveBeenNthCalledWith(2, {
      serverId: entry.serverId,
      command: 'AdminBroadcast',
      args: [entry.broadcastText],
    });
  });

  it('fires a recurring entry across two consecutive ticks for two consecutive matching cron occurrences, and not again on a third tick with no new occurrence', async () => {
    let entry = makeEntry({
      recurrence: '*/2 * * * *',
      createdAt: new Date('2026-07-11T09:55:00.000Z'),
      lastExecutedAt: null,
    });
    const setLastExecutedAt = vi.fn(async (_id: string, executedAt: Date) => {
      entry = { ...entry, lastExecutedAt: executedAt };
    });

    const tick1Deps = makeDeps({
      now: new Date('2026-07-11T10:00:00.000Z'),
      loadEnabledEntries: vi.fn().mockImplementation(async () => [entry]),
      setLastExecutedAt,
    });
    const result1 = await runSeedScheduleTick(tick1Deps);
    expect(result1.executed).toBe(1);
    expect(entry.lastExecutedAt).toEqual(new Date('2026-07-11T10:00:00.000Z'));

    const tick2Deps = makeDeps({
      now: new Date('2026-07-11T10:02:00.000Z'),
      loadEnabledEntries: vi.fn().mockImplementation(async () => [entry]),
      setLastExecutedAt,
    });
    const result2 = await runSeedScheduleTick(tick2Deps);
    expect(result2.executed).toBe(1);
    expect(entry.lastExecutedAt).toEqual(new Date('2026-07-11T10:02:00.000Z'));

    // Third tick at the same "now" as tick2 — no new occurrence in the window.
    const tick3Deps = makeDeps({
      now: new Date('2026-07-11T10:02:00.000Z'),
      loadEnabledEntries: vi.fn().mockImplementation(async () => [entry]),
      setLastExecutedAt,
    });
    const result3 = await runSeedScheduleTick(tick3Deps);
    expect(result3.executed).toBe(0);
  });

  it('leaves a not-yet-due entry untouched', async () => {
    const entry = makeEntry({ startsAt: new Date('2026-07-11T10:00:00.000Z') });
    const deps = makeDeps({
      now: new Date('2026-07-11T09:00:00.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
    });

    const result = await runSeedScheduleTick(deps);

    expect(result).toEqual({ executed: 0, skippedDepotUpdate: 0 });
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.setLastExecutedAt).not.toHaveBeenCalled();
  });

  it('skips a due entry (without advancing last_executed_at) and audits the skip when depot:updating is set', async () => {
    const entry = makeEntry({ startsAt: new Date('2026-07-11T10:00:00.000Z') });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
      isDepotUpdating: vi.fn().mockResolvedValue(true),
    });

    const result = await runSeedScheduleTick(deps);

    expect(result).toEqual({ executed: 0, skippedDepotUpdate: 1 });
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.setLastExecutedAt).not.toHaveBeenCalled();
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'system', label: 'seed-scheduler' },
        actionType: 'server.seed_schedule.skip_depot_update',
        targetId: entry.id,
      }),
    );
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'seed_schedule.skipped_depot_update', severity: 'warn' }),
    );
  });

  it('does not set last_executed_at when the RCON enqueue fails, so the occurrence retries next tick', async () => {
    const entry = makeEntry({ startsAt: new Date('2026-07-11T10:00:00.000Z') });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledEntries: vi.fn().mockResolvedValue([entry]),
      sendRconCommand: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    });

    const result = await runSeedScheduleTick(deps);

    expect(result).toEqual({ executed: 0, skippedDepotUpdate: 0 });
    expect(deps.setLastExecutedAt).not.toHaveBeenCalled();
    expect(deps.writeAuditEntry).not.toHaveBeenCalled();
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'seed_schedule.rcon_failed', severity: 'error' }),
    );
  });
});
