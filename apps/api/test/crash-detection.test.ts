import { describe, expect, it } from 'vitest';
import {
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  detectCrash,
  detectCrashLoop,
} from '../src/plugins/status-reconciler.js';

describe('detectCrash', () => {
  it('returns null on first observation (sets baseline)', () => {
    const state = new Map<string, number>();
    const result = detectCrash(
      's1',
      { restart_count: 1, oom_killed: false, exit_code: 137, finished_at: '2026-05-05T10:00:00Z' },
      state,
    );
    expect(result).toBeNull();
  });

  it('detects crash when restart_count increments', () => {
    const state = new Map<string, number>();
    detectCrash('s1', { restart_count: 1, exit_code: 0, finished_at: '' }, state);
    const result = detectCrash(
      's1',
      { restart_count: 2, oom_killed: true, exit_code: 137, finished_at: '2026-05-05T10:01:00Z' },
      state,
    );
    expect(result).not.toBeNull();
    expect(result?.restart_count).toBe(2);
    expect(result?.oom_killed).toBe(true);
    expect(result?.exit_code).toBe(137);
    expect(result?.finished_at).toBe('2026-05-05T10:01:00Z');
  });

  it('returns null when restart_count unchanged', () => {
    const state = new Map<string, number>();
    detectCrash('s1', { restart_count: 3, exit_code: 0, finished_at: '' }, state);
    const result = detectCrash('s1', { restart_count: 3, exit_code: 0, finished_at: '' }, state);
    expect(result).toBeNull();
  });

  it('returns null when restart_count decrements (edge case: container replaced)', () => {
    const state = new Map<string, number>();
    detectCrash('s1', { restart_count: 5, exit_code: 0, finished_at: '' }, state);
    const result = detectCrash('s1', { restart_count: 0, exit_code: 0, finished_at: '' }, state);
    expect(result).toBeNull();
  });

  it('defaults oom_killed to false when not provided', () => {
    const state = new Map<string, number>();
    detectCrash('s1', { restart_count: 0, exit_code: 0, finished_at: '' }, state);
    const result = detectCrash(
      's1',
      { restart_count: 1, exit_code: 1, finished_at: '2026-05-05T10:00:00Z' },
      state,
    );
    expect(result).not.toBeNull();
    expect(result?.oom_killed).toBe(false);
  });

  it('tracks separate baselines per server id', () => {
    const state = new Map<string, number>();
    detectCrash('s1', { restart_count: 1, exit_code: 0, finished_at: '' }, state);
    detectCrash('s2', { restart_count: 2, exit_code: 0, finished_at: '' }, state);

    // s1 increments
    const r1 = detectCrash('s1', { restart_count: 2, exit_code: 1, finished_at: 'ts1' }, state);
    expect(r1).not.toBeNull();
    expect(r1?.restart_count).toBe(2);

    // s2 unchanged
    const r2 = detectCrash('s2', { restart_count: 2, exit_code: 0, finished_at: '' }, state);
    expect(r2).toBeNull();
  });
});

describe('detectCrashLoop', () => {
  it('detects crash loop when threshold met within window', () => {
    const now = Date.now();
    const crashes = [{ timestamp: now - 60_000 }, { timestamp: now - 30_000 }, { timestamp: now }];
    expect(detectCrashLoop(crashes, CRASH_LOOP_WINDOW_MS, CRASH_LOOP_THRESHOLD)).toBe(true);
  });

  it('does not trigger for spread-out crashes (outside window)', () => {
    const now = Date.now();
    const crashes = [
      { timestamp: now - 600_000 },
      { timestamp: now - 400_000 },
      { timestamp: now },
    ];
    expect(detectCrashLoop(crashes, CRASH_LOOP_WINDOW_MS, CRASH_LOOP_THRESHOLD)).toBe(false);
  });

  it('returns false for empty crash list', () => {
    expect(detectCrashLoop([], CRASH_LOOP_WINDOW_MS, CRASH_LOOP_THRESHOLD)).toBe(false);
  });

  it('returns false when below threshold', () => {
    const now = Date.now();
    const crashes = [{ timestamp: now - 10_000 }, { timestamp: now }];
    // threshold is 3, only 2 recent crashes
    expect(detectCrashLoop(crashes, CRASH_LOOP_WINDOW_MS, CRASH_LOOP_THRESHOLD)).toBe(false);
  });

  it('exact threshold count triggers loop', () => {
    const now = Date.now();
    const crashes = Array.from({ length: CRASH_LOOP_THRESHOLD }, (_, i) => ({
      timestamp: now - i * 10_000,
    }));
    expect(detectCrashLoop(crashes, CRASH_LOOP_WINDOW_MS, CRASH_LOOP_THRESHOLD)).toBe(true);
  });

  it('uses custom window and threshold', () => {
    const now = Date.now();
    const crashes = [{ timestamp: now - 1_000 }, { timestamp: now }];
    expect(detectCrashLoop(crashes, 5_000, 2)).toBe(true);
    expect(detectCrashLoop(crashes, 5_000, 3)).toBe(false);
  });

  it('CRASH_LOOP_WINDOW_MS is 5 minutes', () => {
    expect(CRASH_LOOP_WINDOW_MS).toBe(300_000);
  });

  it('CRASH_LOOP_THRESHOLD is 3', () => {
    expect(CRASH_LOOP_THRESHOLD).toBe(3);
  });
});
