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

/** A sweep result the bridge returns, defaulting the counters the caller emits. */
function sweepResult(overrides: Record<string, unknown> = {}) {
  return {
    retention_days: 10,
    cutoff: '2026-06-27T12:00:00Z',
    servers_scanned: 0,
    log_dirs_scanned: 0,
    files_scanned: 0,
    deleted_count: 0,
    deleted_bytes: 0,
    archived_count: 0,
    archived_bytes: 0,
    error_count: 0,
    errors: [],
    ...overrides,
  };
}

describe('runLogRetentionSweep', () => {
  it('passes only archive-flagged servers to the bridge and emits archive counters', async () => {
    const bridge = {
      squadLogRetentionSweep: vi.fn().mockResolvedValue(
        sweepResult({
          servers_scanned: 2,
          log_dirs_scanned: 2,
          files_scanned: 8,
          deleted_count: 3,
          deleted_bytes: 4096,
          archived_count: 2,
          archived_bytes: 2048,
        }),
      ),
    };
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const log = makeLogger();
    const flagged = ['019dbaa5-1234-7abc-8def-0123456789ab'];
    const listArchiveServerIds = vi.fn().mockResolvedValue(flagged);

    await runLogRetentionSweep({ bridge, diag, log, listArchiveServerIds });

    expect(listArchiveServerIds).toHaveBeenCalledOnce();
    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledExactlyOnceWith({
      archive_server_ids: flagged,
    });
    expect(log.info).toHaveBeenCalledWith(
      {
        retention_days: 10,
        cutoff: '2026-06-27T12:00:00Z',
        servers_scanned: 2,
        log_dirs_scanned: 2,
        files_scanned: 8,
        deleted_count: 3,
        deleted_bytes: 4096,
        archived_count: 2,
        archived_bytes: 2048,
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
      message: 'log retention sweep completed: deleted=3, archived=2, bytes=4096, errors=0',
      payload: {
        retention_days: 10,
        deleted_count: 3,
        deleted_bytes: 4096,
        archived_count: 2,
        archived_bytes: 2048,
        error_count: 0,
      },
    });
  });

  it('passes an empty set when no servers are flagged (delete-only, backwards compatible)', async () => {
    const bridge = {
      squadLogRetentionSweep: vi.fn().mockResolvedValue(sweepResult({ deleted_count: 1 })),
    };
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const log = makeLogger();
    const listArchiveServerIds = vi.fn().mockResolvedValue([]);

    await runLogRetentionSweep({ bridge, diag, log, listArchiveServerIds });

    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledExactlyOnceWith({
      archive_server_ids: [],
    });
  });

  it('does not crash the worker when the bridge sweep fails', async () => {
    const bridge = {
      squadLogRetentionSweep: vi.fn().mockRejectedValue(new Error('bridge unavailable')),
    };
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const log = makeLogger();
    const listArchiveServerIds = vi.fn().mockResolvedValue([]);

    await expect(
      runLogRetentionSweep({ bridge, diag, log, listArchiveServerIds }),
    ).resolves.toBeUndefined();

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

  it('does not delete anything when the flag lookup fails', async () => {
    const bridge = { squadLogRetentionSweep: vi.fn() };
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const log = makeLogger();
    const listArchiveServerIds = vi.fn().mockRejectedValue(new Error('db down'));

    await expect(
      runLogRetentionSweep({ bridge, diag, log, listArchiveServerIds }),
    ).resolves.toBeUndefined();

    expect(bridge.squadLogRetentionSweep).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith({ err: 'db down' }, 'log retention sweep failed');
  });
});

describe('scheduleLogRetentionSweep', () => {
  it('runs once on startup, repeats hourly, and stops cleanly', async () => {
    vi.useFakeTimers();
    const bridge = {
      squadLogRetentionSweep: vi.fn().mockResolvedValue(sweepResult()),
    };
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const log = makeLogger();
    const listArchiveServerIds = vi.fn().mockResolvedValue([]);

    const stop = scheduleLogRetentionSweep({ bridge, diag, log, listArchiveServerIds });
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
    const result = sweepResult();
    const bridge = {
      squadLogRetentionSweep: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue(result),
    };
    const diag = { emit: vi.fn().mockResolvedValue(undefined) };
    const log = makeLogger();
    const listArchiveServerIds = vi.fn().mockResolvedValue([]);

    const stop = scheduleLogRetentionSweep({ bridge, diag, log, listArchiveServerIds });
    await Promise.resolve();
    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LOG_RETENTION_SWEEP_INTERVAL_MS);
    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledTimes(1);

    resolveFirst?.(result);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(LOG_RETENTION_SWEEP_INTERVAL_MS);
    expect(bridge.squadLogRetentionSweep).toHaveBeenCalledTimes(2);

    stop();
    vi.useRealTimers();
  });
});
