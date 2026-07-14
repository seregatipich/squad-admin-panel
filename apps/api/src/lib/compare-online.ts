/**
 * Pure co-presence math for ALT-4 ("Сравнение онлайна двух игроков").
 *
 * Given the raw `player_sessions` rows of two players over a shared time
 * window, this module answers: how much time were both players online at
 * the same time, and how many separate concurrent-presence intervals were
 * there? No database access happens here — the route layer
 * (`../routes/player-compare-online.ts`) is responsible for querying
 * sessions and passing them in.
 */

/** A raw session row as read from `player_sessions` (only the fields the overlap math needs). */
export interface RawSession {
  connectedAt: Date;
  disconnectedAt: Date | null;
}

/** A half-open `[startMs, endMs)` time interval in epoch milliseconds. */
export interface ClosedInterval {
  startMs: number;
  endMs: number;
}

/** One interval of confirmed co-presence, in epoch milliseconds. */
export interface ConcurrentInterval {
  fromMs: number;
  toMs: number;
}

export interface CoPresenceResult {
  /** Total seconds both players were online at the same time, summed across all concurrent intervals. */
  totalOverlapSeconds: number;
  /** The disjoint concurrent-presence intervals themselves, in chronological order. */
  concurrentIntervals: ConcurrentInterval[];
  /** Number of separate concurrent-presence intervals (`concurrentIntervals.length`). */
  concurrentCount: number;
}

/**
 * Converts raw sessions into closed `[startMs, endMs)` intervals clamped to
 * the `[windowStartMs, windowEndMs)` reporting window.
 *
 * An open session (`disconnectedAt === null`, i.e. the player is currently
 * connected) is treated as running until `nowMs`. Intervals that end up
 * zero-length or inverted after clamping (fully outside the window) are
 * dropped.
 */
export function clampSessions(
  sessions: readonly RawSession[],
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number,
): ClosedInterval[] {
  const clamped: ClosedInterval[] = [];
  for (const session of sessions) {
    const rawStart = session.connectedAt.getTime();
    const rawEnd = session.disconnectedAt ? session.disconnectedAt.getTime() : nowMs;
    const startMs = Math.max(rawStart, windowStartMs);
    const endMs = Math.min(rawEnd, windowEndMs);
    if (endMs > startMs) clamped.push({ startMs, endMs });
  }
  return clamped;
}

/**
 * Merges overlapping and touching intervals into the smallest equivalent
 * set of disjoint intervals, sorted by start time. Touching intervals
 * (`next.startMs === prev.endMs`) are merged since they represent
 * back-to-back sessions with no gap in presence.
 */
export function mergeIntervals(intervals: readonly ClosedInterval[]): ClosedInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  // biome-ignore lint/style/noNonNullAssertion: sorted is non-empty (checked above)
  const merged: ClosedInterval[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i < sorted.length
    const current = sorted[i]!;
    // biome-ignore lint/style/noNonNullAssertion: merged always has at least one entry
    const last = merged[merged.length - 1]!;
    if (current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/**
 * Computes the time both players were online simultaneously within
 * `[windowStartMs, windowEndMs)`.
 *
 * Each player's sessions are independently clamped to the window and open
 * sessions clamped to `nowMs`, then merged into disjoint intervals, then
 * intersected against the other player's merged intervals. Touching
 * endpoints (one session ending exactly when the other starts) do not
 * count as overlap — co-presence requires strictly overlapping time.
 * Overlap is purely time-based: it does not matter whether the two
 * sessions were on the same server.
 */
export function computeCoPresence(
  sessionsA: readonly RawSession[],
  sessionsB: readonly RawSession[],
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number,
): CoPresenceResult {
  const mergedA = mergeIntervals(clampSessions(sessionsA, windowStartMs, windowEndMs, nowMs));
  const mergedB = mergeIntervals(clampSessions(sessionsB, windowStartMs, windowEndMs, nowMs));

  const concurrentIntervals: ConcurrentInterval[] = [];
  let i = 0;
  let j = 0;
  while (i < mergedA.length && j < mergedB.length) {
    // biome-ignore lint/style/noNonNullAssertion: i < mergedA.length
    const a = mergedA[i]!;
    // biome-ignore lint/style/noNonNullAssertion: j < mergedB.length
    const b = mergedB[j]!;
    const fromMs = Math.max(a.startMs, b.startMs);
    const toMs = Math.min(a.endMs, b.endMs);
    if (fromMs < toMs) concurrentIntervals.push({ fromMs, toMs });
    if (a.endMs < b.endMs) i++;
    else j++;
  }

  const totalOverlapSeconds = concurrentIntervals.reduce(
    (sum, interval) => sum + Math.floor((interval.toMs - interval.fromMs) / 1000),
    0,
  );

  return {
    totalOverlapSeconds,
    concurrentIntervals,
    concurrentCount: concurrentIntervals.length,
  };
}
