import { describe, expect, it } from 'vitest';
import { detectCrash } from '../src/plugins/status-reconciler.js';

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
