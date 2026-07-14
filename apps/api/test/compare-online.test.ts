import { describe, expect, it } from 'vitest';
import {
  clampSessions,
  computeCoPresence,
  mergeIntervals,
  type RawSession,
} from '../src/lib/compare-online.js';

const HOUR_MS = 3_600_000;
const WINDOW_START = Date.parse('2026-07-01T00:00:00.000Z');
const WINDOW_END = Date.parse('2026-07-08T00:00:00.000Z'); // 7-day window
const NOW = Date.parse('2026-07-07T12:00:00.000Z');

function session(connectedAt: string, disconnectedAt: string | null): RawSession {
  return {
    connectedAt: new Date(connectedAt),
    disconnectedAt: disconnectedAt ? new Date(disconnectedAt) : null,
  };
}

describe('clampSessions', () => {
  it('clamps an open session (disconnectedAt null) to nowMs', () => {
    const sessions = [session('2026-07-07T10:00:00.000Z', null)];
    const [interval] = clampSessions(sessions, WINDOW_START, WINDOW_END, NOW);
    expect(interval).toEqual({
      startMs: Date.parse('2026-07-07T10:00:00.000Z'),
      endMs: NOW,
    });
  });

  it('drops sessions fully outside the window', () => {
    const before = session('2026-06-01T10:00:00.000Z', '2026-06-01T11:00:00.000Z');
    const after = session('2026-08-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z');
    expect(clampSessions([before, after], WINDOW_START, WINDOW_END, NOW)).toEqual([]);
  });

  it('clamps a session straddling the window start boundary', () => {
    const straddling = session('2026-06-30T23:00:00.000Z', '2026-07-01T01:00:00.000Z');
    const [interval] = clampSessions([straddling], WINDOW_START, WINDOW_END, NOW);
    expect(interval).toEqual({
      startMs: WINDOW_START,
      endMs: Date.parse('2026-07-01T01:00:00.000Z'),
    });
  });

  it('clamps a session straddling the window end boundary', () => {
    const straddling = session('2026-07-07T23:00:00.000Z', '2026-07-08T02:00:00.000Z');
    const [interval] = clampSessions([straddling], WINDOW_START, WINDOW_END, NOW);
    expect(interval).toEqual({
      startMs: Date.parse('2026-07-07T23:00:00.000Z'),
      endMs: WINDOW_END,
    });
  });

  it('drops a session that becomes zero-length after clamping', () => {
    const touchingEnd = session('2026-07-08T00:00:00.000Z', '2026-07-08T01:00:00.000Z');
    expect(clampSessions([touchingEnd], WINDOW_START, WINDOW_END, NOW)).toEqual([]);
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping intervals', () => {
    const merged = mergeIntervals([
      { startMs: 0, endMs: 10 * HOUR_MS },
      { startMs: 5 * HOUR_MS, endMs: 15 * HOUR_MS },
    ]);
    expect(merged).toEqual([{ startMs: 0, endMs: 15 * HOUR_MS }]);
  });

  it('merges touching intervals (back-to-back sessions)', () => {
    const merged = mergeIntervals([
      { startMs: 0, endMs: 10 * HOUR_MS },
      { startMs: 10 * HOUR_MS, endMs: 20 * HOUR_MS },
    ]);
    expect(merged).toEqual([{ startMs: 0, endMs: 20 * HOUR_MS }]);
  });

  it('keeps disjoint intervals separate, sorted by start', () => {
    const merged = mergeIntervals([
      { startMs: 20 * HOUR_MS, endMs: 21 * HOUR_MS },
      { startMs: 0, endMs: 1 * HOUR_MS },
    ]);
    expect(merged).toEqual([
      { startMs: 0, endMs: 1 * HOUR_MS },
      { startMs: 20 * HOUR_MS, endMs: 21 * HOUR_MS },
    ]);
  });

  it('returns an empty array for no intervals', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe('computeCoPresence', () => {
  it('reports zero overlap for fully disjoint sessions', () => {
    const a = [session('2026-07-02T10:00:00.000Z', '2026-07-02T11:00:00.000Z')];
    const b = [session('2026-07-03T10:00:00.000Z', '2026-07-03T11:00:00.000Z')];
    const result = computeCoPresence(a, b, WINDOW_START, WINDOW_END, NOW);
    expect(result).toEqual({ totalOverlapSeconds: 0, concurrentIntervals: [], concurrentCount: 0 });
  });

  it('hand-computes a 1-hour overlap for A=[10:00-12:00], B=[11:00-13:00]', () => {
    const a = [session('2026-07-02T10:00:00.000Z', '2026-07-02T12:00:00.000Z')];
    const b = [session('2026-07-02T11:00:00.000Z', '2026-07-02T13:00:00.000Z')];
    const result = computeCoPresence(a, b, WINDOW_START, WINDOW_END, NOW);
    expect(result.totalOverlapSeconds).toBe(3600);
    expect(result.concurrentCount).toBe(1);
    expect(result.concurrentIntervals).toEqual([
      {
        fromMs: Date.parse('2026-07-02T11:00:00.000Z'),
        toMs: Date.parse('2026-07-02T12:00:00.000Z'),
      },
    ]);
  });

  it('counts touching endpoints (A ends exactly when B starts) as zero overlap', () => {
    const a = [session('2026-07-02T10:00:00.000Z', '2026-07-02T12:00:00.000Z')];
    const b = [session('2026-07-02T12:00:00.000Z', '2026-07-02T13:00:00.000Z')];
    const result = computeCoPresence(a, b, WINDOW_START, WINDOW_END, NOW);
    expect(result).toEqual({ totalOverlapSeconds: 0, concurrentIntervals: [], concurrentCount: 0 });
  });

  it('reports full containment when B is entirely inside A', () => {
    const a = [session('2026-07-02T09:00:00.000Z', '2026-07-02T15:00:00.000Z')];
    const b = [session('2026-07-02T10:00:00.000Z', '2026-07-02T11:00:00.000Z')];
    const result = computeCoPresence(a, b, WINDOW_START, WINDOW_END, NOW);
    expect(result.totalOverlapSeconds).toBe(3600);
    expect(result.concurrentCount).toBe(1);
  });

  it('counts multiple disjoint overlaps as separate concurrent intervals', () => {
    const a = [
      session('2026-07-02T09:00:00.000Z', '2026-07-02T10:00:00.000Z'),
      session('2026-07-02T14:00:00.000Z', '2026-07-02T15:00:00.000Z'),
    ];
    const b = [
      session('2026-07-02T09:30:00.000Z', '2026-07-02T10:30:00.000Z'),
      session('2026-07-02T14:30:00.000Z', '2026-07-02T14:45:00.000Z'),
    ];
    const result = computeCoPresence(a, b, WINDOW_START, WINDOW_END, NOW);
    expect(result.concurrentCount).toBe(2);
    expect(result.totalOverlapSeconds).toBe(30 * 60 + 15 * 60);
  });

  it('counts overlap across different servers the same way (co-presence is time-based only)', () => {
    // The pure helper never sees server_id — overlap is computed purely on time,
    // regardless of which server each session happened on.
    const a = [session('2026-07-02T10:00:00.000Z', '2026-07-02T12:00:00.000Z')];
    const b = [session('2026-07-02T11:00:00.000Z', '2026-07-02T13:00:00.000Z')];
    const result = computeCoPresence(a, b, WINDOW_START, WINDOW_END, NOW);
    expect(result.totalOverlapSeconds).toBe(3600);
  });

  it('clamps an open session for one player to nowMs before intersecting', () => {
    const a = [session('2026-07-07T10:00:00.000Z', null)]; // still online
    const b = [session('2026-07-07T11:00:00.000Z', '2026-07-07T13:00:00.000Z')];
    const result = computeCoPresence(a, b, WINDOW_START, WINDOW_END, NOW);
    // A runs 10:00 -> NOW (12:00), B runs 11:00 -> 13:00; overlap is 11:00-12:00 = 1h
    expect(result.totalOverlapSeconds).toBe(3600);
    expect(result.concurrentCount).toBe(1);
  });

  it('merges each player-side back-to-back sessions before intersecting', () => {
    const a = [
      session('2026-07-02T09:00:00.000Z', '2026-07-02T10:00:00.000Z'),
      session('2026-07-02T10:00:00.000Z', '2026-07-02T11:00:00.000Z'),
    ];
    const b = [session('2026-07-02T09:30:00.000Z', '2026-07-02T10:30:00.000Z')];
    const result = computeCoPresence(a, b, WINDOW_START, WINDOW_END, NOW);
    expect(result.concurrentCount).toBe(1);
    expect(result.totalOverlapSeconds).toBe(3600);
  });
});
