import { describe, expect, it, vi } from 'vitest';
import { FetchSourceError } from '../src/fetch-source.js';
import {
  ALERT_CONSECUTIVE_FAILURE_THRESHOLD,
  type SyncSourceDeps,
  syncSource,
} from '../src/sync-source.js';

function makeSource(overrides: Partial<Parameters<typeof syncSource>[1]> = {}) {
  return {
    id: 'source-1',
    name: 'RuBans',
    url: 'https://example.com/bans.cfg',
    format: 'squad_bans_cfg' as const,
    authHeaderEncrypted: null,
    parserConfig: {},
    consecutiveFailures: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SyncSourceDeps> = {}): SyncSourceDeps {
  return {
    now: () => new Date('2026-07-14T12:00:00.000Z'),
    decryptAuthHeader: vi.fn().mockReturnValue('Bearer token'),
    fetchBanList: vi.fn().mockResolvedValue({
      text: 'Banned:76561198000000001:0',
      bytes: 27,
      durationMs: 42,
    }),
    loadExistingBans: vi.fn().mockResolvedValue([]),
    applyMergePlan: vi.fn().mockResolvedValue({ added: 1, updated: 0, revoked: 0 }),
    updateSourceOk: vi.fn().mockResolvedValue(undefined),
    updateSourceError: vi.fn().mockResolvedValue(undefined),
    persistAndPublish: vi.fn().mockResolvedValue(undefined),
    raiseFailureAlert: vi.fn().mockResolvedValue(0),
    diag: { emit: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

describe('syncSource', () => {
  it('on success: resets consecutiveFailures, updates the source row ok, and emits bansync.completed', async () => {
    const deps = makeDeps({ onSyncComplete: vi.fn().mockResolvedValue(undefined) });
    const report = await syncSource(deps, makeSource());

    expect(report.ok).toBe(true);
    expect(report.added).toBe(1);
    expect(deps.updateSourceOk).toHaveBeenCalledWith(
      'source-1',
      expect.objectContaining({ importedCount: 1 }),
    );
    expect(deps.updateSourceError).not.toHaveBeenCalled();
    expect(deps.persistAndPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bansync.completed',
        payload: expect.objectContaining({
          source_id: 'source-1',
          added: 1,
          updated: 0,
          revoked: 0,
          duration_ms: 42,
          bytes: 27,
        }),
      }),
    );
    expect(deps.raiseFailureAlert).not.toHaveBeenCalled();
    expect(deps.onSyncComplete).toHaveBeenCalledOnce();
  });

  it('on fetch error: records last_sync_status=error with the message, increments consecutiveFailures, emits bansync.failed', async () => {
    const deps = makeDeps({
      fetchBanList: vi.fn().mockRejectedValue(new FetchSourceError('http_status', 'HTTP 500')),
    });
    const report = await syncSource(deps, makeSource({ consecutiveFailures: 1 }));

    expect(report.ok).toBe(false);
    expect(report.error).toBe('HTTP 500');
    expect(deps.updateSourceError).toHaveBeenCalledWith(
      'source-1',
      expect.objectContaining({ lastSyncError: 'HTTP 500', consecutiveFailures: 2 }),
    );
    expect(deps.persistAndPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bansync.failed',
        payload: expect.objectContaining({ consecutive_failures: 2, error: 'HTTP 500' }),
      }),
    );
  });

  it('raises the AUTO-3 alert exactly on the 3rd consecutive failure, not the 2nd or the 4th', async () => {
    const failingDeps = makeDeps({
      fetchBanList: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await syncSource(failingDeps, makeSource({ consecutiveFailures: 1 })); // -> 2nd failure
    expect(failingDeps.raiseFailureAlert).not.toHaveBeenCalled();

    await syncSource(failingDeps, makeSource({ consecutiveFailures: 2 })); // -> 3rd failure
    expect(failingDeps.raiseFailureAlert).toHaveBeenCalledTimes(1);
    expect(failingDeps.raiseFailureAlert).toHaveBeenCalledWith(
      { id: 'source-1', name: 'RuBans' },
      'boom',
      ALERT_CONSECUTIVE_FAILURE_THRESHOLD,
    );

    await syncSource(failingDeps, makeSource({ consecutiveFailures: 3 })); // -> 4th failure
    expect(failingDeps.raiseFailureAlert).toHaveBeenCalledTimes(1);
  });

  it('surfaces a size-limit fetch error as a typed, readable lastSyncError', async () => {
    const deps = makeDeps({
      fetchBanList: vi
        .fn()
        .mockRejectedValue(new FetchSourceError('size_limit_exceeded', 'body exceeded 20MB cap')),
    });
    const report = await syncSource(deps, makeSource());
    expect(report.error).toBe('body exceeded 20MB cap');
  });

  it('surfaces a timeout fetch error as a typed, readable lastSyncError', async () => {
    const deps = makeDeps({
      fetchBanList: vi.fn().mockRejectedValue(new FetchSourceError('timeout', 'fetch timed out')),
    });
    const report = await syncSource(deps, makeSource());
    expect(report.error).toBe('fetch timed out');
  });

  it('decrypts the auth header when present and passes it to fetchBanList', async () => {
    const deps = makeDeps();
    await syncSource(deps, makeSource({ authHeaderEncrypted: Buffer.from('blob') }));
    expect(deps.decryptAuthHeader).toHaveBeenCalledWith(Buffer.from('blob'));
    expect(deps.fetchBanList).toHaveBeenCalledWith('https://example.com/bans.cfg', 'Bearer token');
  });
});
