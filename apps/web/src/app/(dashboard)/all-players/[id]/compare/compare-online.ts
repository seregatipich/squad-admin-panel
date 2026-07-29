import type { CSSProperties } from 'react';

import {
  buildWeekGrid,
  DAY_MS,
  fmtDuration,
  HOUR_MS,
  type PresenceSession,
  utcDayKey,
  WEEK_DAYS,
} from '../presence';

/** A single player's session as returned by `/compare-online` (same shape as `PresenceSession`). */
export type CompareSession = PresenceSession;

export interface ComparePlayer {
  id: string;
  canonical_name: string;
  steam_id64: string | null;
}

export interface CompareOverlapInterval {
  from: string;
  to: string;
}

export interface CompareOnlineResponse {
  window: { from: string; to: string };
  players: [ComparePlayer, ComparePlayer];
  sessions: { a: CompareSession[]; b: CompareSession[] };
  overlap: {
    total_seconds: number;
    concurrent_count: number;
    intervals: CompareOverlapInterval[];
  };
}

/** One 1-hour cell of the co-presence week grid. */
export interface CompareCell {
  dayIndex: number;
  hour: number;
  /** Seconds player A was online during this hour. */
  aSeconds: number;
  /** Seconds player B was online during this hour. */
  bSeconds: number;
  /** Seconds both players were online at the same time during this hour. */
  overlapSeconds: number;
}

export interface CompareWeekGrid {
  days: string[];
  cells: CompareCell[][];
}

interface RawInterval {
  startMs: number;
  endMs: number;
}

/** Clamps sessions to `[rangeStart, rangeEnd)`, treating an open session as running until `nowMs`. */
function clampToRange(
  sessions: readonly CompareSession[],
  rangeStart: number,
  rangeEnd: number,
  nowMs: number,
): RawInterval[] {
  const clamped: RawInterval[] = [];
  for (const session of sessions) {
    const rawStart = Date.parse(session.connected_at);
    const rawEnd = session.disconnected_at ? Date.parse(session.disconnected_at) : nowMs;
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const startMs = Math.max(rawStart, rangeStart);
    const endMs = Math.min(rawEnd, rangeEnd);
    if (endMs > startMs) clamped.push({ startMs, endMs });
  }
  return clamped;
}

/** Merges overlapping/touching intervals into the smallest disjoint set, sorted by start time. */
function mergeIntervals(intervals: readonly RawInterval[]): RawInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const merged: RawInterval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/** Total seconds the two (already merged, disjoint) interval lists overlap. Touching endpoints do not count. */
function overlapSecondsBetween(a: readonly RawInterval[], b: readonly RawInterval[]): number {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].startMs, b[j].startMs);
    const end = Math.min(a[i].endMs, b[j].endMs);
    if (start < end) total += (end - start) / 1000;
    if (a[i].endMs < b[j].endMs) i++;
    else j++;
  }
  return total;
}

/**
 * Builds the 7x24 co-presence week grid by overlaying player A and player B
 * sessions. Reuses {@link buildWeekGrid} (from the PRES-4 calendar helpers)
 * for each player's per-hour totals, then computes per-cell overlap with a
 * small local interval-intersection (duplicated from
 * `apps/api/src/lib/compare-online.ts` since the web app cannot import API
 * code) so touching-but-not-concurrent sessions are not counted as overlap.
 */
export function buildCompareWeekGrid(
  sessionsA: readonly CompareSession[],
  sessionsB: readonly CompareSession[],
  weekStartMs: number,
  nowMs: number,
): CompareWeekGrid {
  const gridA = buildWeekGrid([...sessionsA], weekStartMs, nowMs);
  const gridB = buildWeekGrid([...sessionsB], weekStartMs, nowMs);

  const cells: CompareCell[][] = gridA.days.map((_, dayIndex) =>
    Array.from({ length: 24 }, (_, hour) => {
      const cellStart = weekStartMs + dayIndex * DAY_MS + hour * HOUR_MS;
      const cellEnd = cellStart + HOUR_MS;
      const aIntervals = mergeIntervals(clampToRange(sessionsA, cellStart, cellEnd, nowMs));
      const bIntervals = mergeIntervals(clampToRange(sessionsB, cellStart, cellEnd, nowMs));
      return {
        dayIndex,
        hour,
        aSeconds: gridA.cells[dayIndex]?.[hour]?.total_seconds ?? 0,
        bSeconds: gridB.cells[dayIndex]?.[hour]?.total_seconds ?? 0,
        overlapSeconds: overlapSecondsBetween(aIntervals, bIntervals),
      };
    }),
  );

  return { days: gridA.days, cells };
}

const PLAYER_A_HEX = '#38bdf8'; // sky
const PLAYER_B_HEX = '#f59e0b'; // amber
const OVERLAP_HEX = '#10b981'; // emerald

function hexWithAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const byte = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${byte}`;
}

function intensity(seconds: number): number {
  return 0.25 + 0.65 * Math.min(1, seconds / 3600);
}

/**
 * Background style for a co-presence grid cell: emerald with a diagonal
 * stripe when the two players overlapped, otherwise plain sky (A-only),
 * amber (B-only), or a half-sky/half-amber split when both were online
 * that hour but never concurrently.
 */
export function cellStyle(cell: CompareCell): CSSProperties | undefined {
  if (cell.overlapSeconds > 0) {
    const base = hexWithAlpha(OVERLAP_HEX, intensity(cell.overlapSeconds));
    return {
      backgroundColor: base,
      backgroundImage:
        'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0, rgba(255,255,255,0.18) 2px, transparent 2px, transparent 6px)',
    };
  }
  if (cell.aSeconds > 0 && cell.bSeconds > 0) {
    return {
      backgroundImage: `linear-gradient(90deg, ${hexWithAlpha(PLAYER_A_HEX, intensity(cell.aSeconds))} 50%, ${hexWithAlpha(PLAYER_B_HEX, intensity(cell.bSeconds))} 50%)`,
    };
  }
  if (cell.aSeconds > 0)
    return { backgroundColor: hexWithAlpha(PLAYER_A_HEX, intensity(cell.aSeconds)) };
  if (cell.bSeconds > 0)
    return { backgroundColor: hexWithAlpha(PLAYER_B_HEX, intensity(cell.bSeconds)) };
  return undefined;
}

export function cellTitle(cell: CompareCell, dayKey: string): string {
  const hourLabel = `${String(cell.hour).padStart(2, '0')}:00`;
  const parts: string[] = [];
  if (cell.overlapSeconds > 0) parts.push(`совместно ${fmtDuration(cell.overlapSeconds)}`);
  if (cell.aSeconds > 0) parts.push(`A: ${fmtDuration(cell.aSeconds)}`);
  if (cell.bSeconds > 0) parts.push(`B: ${fmtDuration(cell.bSeconds)}`);
  if (parts.length === 0) return `${dayKey} ${hourLabel} — нет активности`;
  return `${dayKey} ${hourLabel} — ${parts.join(' · ')}`;
}

/** «Совместный онлайн за период: Xч Yм · одновременных заходов: N» summary line. */
export function summaryLabel(totalSeconds: number, concurrentCount: number): string {
  return `Совместный онлайн за период: ${fmtDuration(totalSeconds)} · одновременных заходов: ${concurrentCount}`;
}

/** Day-key of the Monday..Sunday(-equivalent) week ending `endDay`, one week earlier. */
export function prevWeekEndDay(endDay: string): string {
  const endMidnight = Date.parse(`${endDay}T00:00:00.000Z`);
  return utcDayKey(endMidnight - WEEK_DAYS * DAY_MS);
}

/** Day-key of the week ending `endDay`, one week later. */
export function nextWeekEndDay(endDay: string): string {
  const endMidnight = Date.parse(`${endDay}T00:00:00.000Z`);
  return utcDayKey(endMidnight + WEEK_DAYS * DAY_MS);
}
