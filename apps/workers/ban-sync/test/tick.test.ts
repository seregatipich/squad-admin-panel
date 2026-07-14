import { describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, type DueSource, isDue, runBanSyncTick } from '../src/tick.js';

const NOW = new Date('2026-07-14T12:00:00.000Z');

function source(overrides: Partial<DueSource> = {}): DueSource {
  return {
    id: 'source-1',
    name: 'RuBans',
    url: 'https://example.com/bans.cfg',
    format: 'squad_bans_cfg',
    authHeaderEncrypted: null,
    parserConfig: {},
    consecutiveFailures: 0,
    lastSyncAt: null,
    pollIntervalMinutes: 15,
    ...overrides,
  };
}

describe('isDue', () => {
  it('is due when lastSyncAt is null', () => {
    expect(isDue(source({ lastSyncAt: null }), NOW)).toBe(true);
  });

  it('is not due when lastSyncAt is within the poll interval', () => {
    expect(
      isDue(
        source({ lastSyncAt: new Date('2026-07-14T11:55:00.000Z'), pollIntervalMinutes: 15 }),
        NOW,
      ),
    ).toBe(false);
  });

  it('is due once the poll interval has elapsed', () => {
    expect(
      isDue(
        source({ lastSyncAt: new Date('2026-07-14T11:40:00.000Z'), pollIntervalMinutes: 15 }),
        NOW,
      ),
    ).toBe(true);
  });
});

describe('backoffDelayMs', () => {
  it('doubles per consecutive failure and caps at 60 minutes', () => {
    expect(backoffDelayMs(0)).toBe(60_000);
    expect(backoffDelayMs(1)).toBe(120_000);
    expect(backoffDelayMs(2)).toBe(240_000);
    expect(backoffDelayMs(10)).toBe(60 * 60_000);
  });
});

describe('runBanSyncTick', () => {
  it('syncs a due source and clears its backoff entry on success', async () => {
    const backoff = new Map([['source-1', { nextAttemptAt: 0 }]]);
    const syncOne = vi.fn().mockResolvedValue({
      ok: true,
      added: 1,
      updated: 0,
      revoked: 0,
      skipped: 0,
      durationMs: 1,
      bytes: 1,
    });
    const result = await runBanSyncTick({
      now: NOW,
      listEnabledSources: async () => [source()],
      syncOne,
      backoff,
    });
    expect(result).toEqual({ synced: 1, failed: 0, skippedBackoff: 0 });
    expect(backoff.has('source-1')).toBe(false);
  });

  it('skips a source that is not due', async () => {
    const syncOne = vi.fn();
    const result = await runBanSyncTick({
      now: NOW,
      listEnabledSources: async () => [
        source({ lastSyncAt: new Date('2026-07-14T11:59:00.000Z'), pollIntervalMinutes: 15 }),
      ],
      syncOne,
      backoff: new Map(),
    });
    expect(result).toEqual({ synced: 0, failed: 0, skippedBackoff: 0 });
    expect(syncOne).not.toHaveBeenCalled();
  });

  it('skips a failed source still inside its backoff window', async () => {
    const backoff = new Map([['source-1', { nextAttemptAt: NOW.getTime() + 60_000 }]]);
    const syncOne = vi.fn();
    const result = await runBanSyncTick({
      now: NOW,
      listEnabledSources: async () => [source()],
      syncOne,
      backoff,
    });
    expect(result).toEqual({ synced: 0, failed: 0, skippedBackoff: 1 });
    expect(syncOne).not.toHaveBeenCalled();
  });

  it('records a backoff entry when a due source fails', async () => {
    const backoff = new Map<string, { nextAttemptAt: number }>();
    const syncOne = vi.fn().mockResolvedValue({
      ok: false,
      added: 0,
      updated: 0,
      revoked: 0,
      skipped: 0,
      durationMs: 1,
      bytes: 0,
      error: 'boom',
    });
    const result = await runBanSyncTick({
      now: NOW,
      listEnabledSources: async () => [source({ consecutiveFailures: 0 })],
      syncOne,
      backoff,
    });
    expect(result).toEqual({ synced: 0, failed: 1, skippedBackoff: 0 });
    const entry = backoff.get('source-1');
    expect(entry?.nextAttemptAt).toBe(NOW.getTime() + backoffDelayMs(1));
  });
});
