import { describe, expect, it, vi } from 'vitest';
import {
  resolveDueOccurrence,
  runScheduledTaskTick,
  type ScheduledTaskEntry,
  type ScheduledTaskTickDeps,
} from '../src/scheduled-task-tick.js';

function makeEntry(overrides: Partial<ScheduledTaskEntry> = {}): ScheduledTaskEntry {
  return {
    id: '019f46a1-0000-7000-8000-000000000001',
    serverId: '019f46a1-0000-7000-8000-000000000099',
    name: 'Nightly restart',
    taskType: 'restart',
    params: {},
    scheduledAt: new Date('2026-07-11T10:00:00.000Z'),
    recurrence: null,
    lastExecutedAt: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ScheduledTaskTickDeps> = {}): ScheduledTaskTickDeps {
  return {
    loadEnabledTasks: vi.fn().mockResolvedValue([]),
    isDepotUpdating: vi.fn().mockResolvedValue(false),
    sendRconCommand: vi.fn().mockResolvedValue(undefined),
    restartServer: vi.fn().mockResolvedValue(undefined),
    setLastExecutedAt: vi.fn().mockResolvedValue(undefined),
    recordRun: vi.fn().mockResolvedValue(undefined),
    writeAuditEntry: vi.fn().mockResolvedValue(undefined),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('resolveDueOccurrence', () => {
  it('is due for a one-off task once scheduled_at <= now and never executed', () => {
    const entry = makeEntry({ scheduledAt: new Date('2026-07-11T10:00:00.000Z') });
    expect(resolveDueOccurrence(entry, new Date('2026-07-11T10:00:01.000Z'))).toEqual(
      entry.scheduledAt,
    );
  });

  it('is not due for a one-off task before scheduled_at', () => {
    const entry = makeEntry({ scheduledAt: new Date('2026-07-11T10:00:00.000Z') });
    expect(resolveDueOccurrence(entry, new Date('2026-07-11T09:59:00.000Z'))).toBeNull();
  });

  it('is never due again for a one-off task once last_executed_at is set', () => {
    const entry = makeEntry({
      scheduledAt: new Date('2026-07-11T10:00:00.000Z'),
      lastExecutedAt: new Date('2026-07-11T10:00:00.000Z'),
    });
    expect(resolveDueOccurrence(entry, new Date('2026-07-12T10:00:00.000Z'))).toBeNull();
  });

  it('fires a recurring task for a cron occurrence after last_executed_at', () => {
    const entry = makeEntry({
      taskType: 'broadcast',
      params: { message: 'hi' },
      scheduledAt: null,
      recurrence: '0 10 * * 6',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      lastExecutedAt: null,
    });
    expect(resolveDueOccurrence(entry, new Date('2026-07-11T10:05:00.000Z'))).toEqual(
      new Date('2026-07-11T10:00:00.000Z'),
    );
  });

  it('does not re-fire the same recurring occurrence once the cursor is advanced past it', () => {
    const entry = makeEntry({
      taskType: 'broadcast',
      params: { message: 'hi' },
      scheduledAt: null,
      recurrence: '0 10 * * 6',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      lastExecutedAt: new Date('2026-07-11T10:00:00.000Z'),
    });
    expect(resolveDueOccurrence(entry, new Date('2026-07-11T10:30:00.000Z'))).toBeNull();
  });

  it('is never due for a task with neither scheduled_at nor recurrence', () => {
    const entry = makeEntry({ scheduledAt: null, recurrence: null });
    expect(resolveDueOccurrence(entry, new Date('2030-01-01T00:00:00.000Z'))).toBeNull();
  });
});

describe('runScheduledTaskTick', () => {
  it('restarts the server for a due restart task, records an executed run, and sets last_executed_at', async () => {
    const entry = makeEntry({ taskType: 'restart', params: {} });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledTasks: vi.fn().mockResolvedValue([entry]),
    });

    const result = await runScheduledTaskTick(deps);

    expect(result).toEqual({ executed: 1, skippedDepotUpdate: 0, failed: 0 });
    expect(deps.restartServer).toHaveBeenCalledWith(entry.serverId);
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.setLastExecutedAt).toHaveBeenCalledWith(entry.id, entry.scheduledAt);
    expect(deps.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: entry.id, status: 'executed' }),
    );
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'system', label: 'task-scheduler' },
        actionType: 'server.scheduled_task.execute',
        targetType: 'scheduled_task',
        targetId: entry.id,
      }),
    );
  });

  it('enqueues AdminSetNextLayer for a due set_next_layer task', async () => {
    const entry = makeEntry({ taskType: 'set_next_layer', params: { layer: 'Narva RAAS v1' } });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledTasks: vi.fn().mockResolvedValue([entry]),
    });

    await runScheduledTaskTick(deps);

    expect(deps.sendRconCommand).toHaveBeenCalledWith({
      serverId: entry.serverId,
      command: 'AdminSetNextLayer',
      args: ['Narva RAAS v1'],
    });
    expect(deps.restartServer).not.toHaveBeenCalled();
  });

  it('enqueues AdminChangeLayer for a due change_layer task', async () => {
    const entry = makeEntry({ taskType: 'change_layer', params: { layer: 'Yehorivka RAAS v1' } });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledTasks: vi.fn().mockResolvedValue([entry]),
    });

    await runScheduledTaskTick(deps);

    expect(deps.sendRconCommand).toHaveBeenCalledWith({
      serverId: entry.serverId,
      command: 'AdminChangeLayer',
      args: ['Yehorivka RAAS v1'],
    });
  });

  it('enqueues AdminBroadcast for a due broadcast task', async () => {
    const entry = makeEntry({
      taskType: 'broadcast',
      params: { message: 'Server restarting soon' },
    });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledTasks: vi.fn().mockResolvedValue([entry]),
    });

    await runScheduledTaskTick(deps);

    expect(deps.sendRconCommand).toHaveBeenCalledWith({
      serverId: entry.serverId,
      command: 'AdminBroadcast',
      args: ['Server restarting soon'],
    });
  });

  it('leaves a not-yet-due task untouched', async () => {
    const entry = makeEntry({ scheduledAt: new Date('2026-07-11T10:00:00.000Z') });
    const deps = makeDeps({
      now: new Date('2026-07-11T09:00:00.000Z'),
      loadEnabledTasks: vi.fn().mockResolvedValue([entry]),
    });

    const result = await runScheduledTaskTick(deps);

    expect(result).toEqual({ executed: 0, skippedDepotUpdate: 0, failed: 0 });
    expect(deps.restartServer).not.toHaveBeenCalled();
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.setLastExecutedAt).not.toHaveBeenCalled();
    expect(deps.recordRun).not.toHaveBeenCalled();
  });

  it('skips a due task (without advancing the cursor) and records skipped_depot_update when depot:updating is set', async () => {
    const entry = makeEntry({ taskType: 'restart' });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledTasks: vi.fn().mockResolvedValue([entry]),
      isDepotUpdating: vi.fn().mockResolvedValue(true),
    });

    const result = await runScheduledTaskTick(deps);

    expect(result).toEqual({ executed: 0, skippedDepotUpdate: 1, failed: 0 });
    expect(deps.restartServer).not.toHaveBeenCalled();
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.setLastExecutedAt).not.toHaveBeenCalled();
    expect(deps.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: entry.id, status: 'skipped_depot_update' }),
    );
    expect(deps.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'server.scheduled_task.skip_depot_update',
        targetId: entry.id,
      }),
    );
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'scheduled_task.skipped_depot_update', severity: 'warn' }),
    );
  });

  it('records a failed run and does not advance the cursor when dispatch throws, so it retries next tick', async () => {
    const entry = makeEntry({ taskType: 'set_next_layer', params: { layer: 'Narva RAAS v1' } });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledTasks: vi.fn().mockResolvedValue([entry]),
      sendRconCommand: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    });

    const result = await runScheduledTaskTick(deps);

    expect(result).toEqual({ executed: 0, skippedDepotUpdate: 0, failed: 1 });
    expect(deps.setLastExecutedAt).not.toHaveBeenCalled();
    expect(deps.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: entry.id, status: 'failed' }),
    );
    expect(deps.diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'scheduled_task.dispatch_failed', severity: 'error' }),
    );
  });

  it('records a failed run for a layer task missing its layer param', async () => {
    const entry = makeEntry({ taskType: 'change_layer', params: {} });
    const deps = makeDeps({
      now: new Date('2026-07-11T10:00:05.000Z'),
      loadEnabledTasks: vi.fn().mockResolvedValue([entry]),
    });

    const result = await runScheduledTaskTick(deps);

    expect(result).toEqual({ executed: 0, skippedDepotUpdate: 0, failed: 1 });
    expect(deps.sendRconCommand).not.toHaveBeenCalled();
    expect(deps.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: entry.id, status: 'failed' }),
    );
  });

  it('fires a recurring task across two consecutive ticks and not again on a third with no new occurrence', async () => {
    let entry = makeEntry({
      taskType: 'broadcast',
      params: { message: 'tick' },
      scheduledAt: null,
      recurrence: '*/2 * * * *',
      createdAt: new Date('2026-07-11T09:55:00.000Z'),
      lastExecutedAt: null,
    });
    const setLastExecutedAt = vi.fn(async (_id: string, executedAt: Date) => {
      entry = { ...entry, lastExecutedAt: executedAt };
    });

    const result1 = await runScheduledTaskTick(
      makeDeps({
        now: new Date('2026-07-11T10:00:00.000Z'),
        loadEnabledTasks: vi.fn().mockImplementation(async () => [entry]),
        setLastExecutedAt,
      }),
    );
    expect(result1.executed).toBe(1);
    expect(entry.lastExecutedAt).toEqual(new Date('2026-07-11T10:00:00.000Z'));

    const result2 = await runScheduledTaskTick(
      makeDeps({
        now: new Date('2026-07-11T10:02:00.000Z'),
        loadEnabledTasks: vi.fn().mockImplementation(async () => [entry]),
        setLastExecutedAt,
      }),
    );
    expect(result2.executed).toBe(1);
    expect(entry.lastExecutedAt).toEqual(new Date('2026-07-11T10:02:00.000Z'));

    const result3 = await runScheduledTaskTick(
      makeDeps({
        now: new Date('2026-07-11T10:02:00.000Z'),
        loadEnabledTasks: vi.fn().mockImplementation(async () => [entry]),
        setLastExecutedAt,
      }),
    );
    expect(result3.executed).toBe(0);
  });
});
