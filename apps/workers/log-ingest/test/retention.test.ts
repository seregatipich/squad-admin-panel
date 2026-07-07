import type { DiagEvent } from '@squad/diag';
import { describe, expect, it, vi } from 'vitest';
import {
  LOG_RETENTION_SWEEP_INTERVAL_MS,
  runLogRetentionSweep,
  scheduleLogRetentionSweep,
} from '../src/retention.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('runLogRetentionSweep', () => {
  it('calls the bridge sweep and emits deletion counters to diagnostics', async () => {
    const bridge = {
      squadLogRetentionSweep: vi.fn().mockResolvedValue({
        retention_days: 10,
        cutoff: '2026-06-27T12:00:00Z',
        servers_scanned: 2,
        log_dirs_scanned: 2,
        files_scanned: 8,
        deleted_count: 3,
        deleted_bytes: 4096,
        error_count: 0,
        errors: [],
      }),
    };
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const log = makeLogger();

    await runLogRetentionSweep({ bridge, diag, log });

    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith(
      {
        retention_days: 10,
        cutoff: '2026-06-27T12:00:00Z',
        servers_scanned: 2,
        log_dirs_scanned: 2,
        files_scanned: 8,
        deleted_count: 3,
        deleted_bytes: 4096,
        error_count: 0,
      },
      'log retention sweep completed',
    );
    expect(diag.emit).toHaveBeenCalledOnce();
    const event = diag.emit.mock.calls[0]?.[0] as DiagEvent;
    expect(event).toMatchObject({
      component: 'worker-log-ingest',
      kind: 'log.retention.sweep',
      severity: 'info',
      message: 'log retention sweep completed: deleted=3, bytes=4096, errors=0',
      payload: {
        retention_days: 10,
        cutoff: '2026-06-27T12:00:00Z',
        servers_scanned: 2,
        log_dirs_scanned: 2,
        files_scanned: 8,
        deleted_count: 3,
        deleted_bytes: 4096,
        error_count: 0,
      },
    });
  });

  it('does not crash the worker when the bridge sweep fails', async () => {
    const bridge = {
      squadLogRetentionSweep: vi.fn().mockRejectedValue(new Error('bridge unavailable')),
    };
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const log = makeLogger();

    await expect(runLogRetentionSweep({ bridge, diag, log })).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledWith(
      { err: 'bridge unavailable' },
      'log retention sweep failed',
    );
    expect(diag.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'worker-log-ingest',
        kind: 'log.retention.sweep_failed',
        severity: 'error',
        message: 'log retention sweep failed: bridge unavailable',
      }),
    );
  });
});

describe('scheduleLogRetentionSweep', () => {
  it('runs once on startup, repeats hourly, and stops cleanly', async () => {
    vi.useFakeTimers();
    const bridge = {
      squadLogRetentionSweep: vi.fn().mockResolvedValue({
        retention_days: 10,
        cutoff: '2026-06-27T12:00:00Z',
        servers_scanned: 0,
        log_dirs_scanned: 0,
        files_scanned: 0,
        deleted_count: 0,
        deleted_bytes: 0,
        error_count: 0,
        errors: [],
      }),
    };
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const log = makeLogger();

    const stop = scheduleLogRetentionSweep({ bridge, diag, log });
    await Promise.resolve();
    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LOG_RETENTION_SWEEP_INTERVAL_MS);
    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(LOG_RETENTION_SWEEP_INTERVAL_MS);
    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not overlap sweeps when the previous run is still in flight', async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: unknown) => void) | undefined;
    const sweepResult = {
      retention_days: 10,
      cutoff: '2026-06-27T12:00:00Z',
      servers_scanned: 0,
      log_dirs_scanned: 0,
      files_scanned: 0,
      deleted_count: 0,
      deleted_bytes: 0,
      error_count: 0,
      errors: [],
    };
    const bridge = {
      squadLogRetentionSweep: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue(sweepResult),
    };
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const log = makeLogger();

    const stop = scheduleLogRetentionSweep({ bridge, diag, log });
    await Promise.resolve();
    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LOG_RETENTION_SWEEP_INTERVAL_MS);
    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledTimes(1);

    resolveFirst?.(sweepResult);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(LOG_RETENTION_SWEEP_INTERVAL_MS);
    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledTimes(2);

    stop();
    vi.useRealTimers();
  });
});
