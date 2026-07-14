import { expandCron5Occurrences } from '@squad/shared-types';

/** One row of `GET /api/v1/servers/:id/seed-schedule`'s `entries` array. */
export interface SeedScheduleEntry {
  id: string;
  server_id: string;
  starts_at: string;
  seed_layer: string;
  broadcast_text: string | null;
  /** 5-field cron expression, UTC. Null = one-off. */
  recurrence: string | null;
  enabled: boolean;
  created_by: string | null;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One historical seeding window, as returned by the `/seed-schedule/history` endpoint. */
export interface SeedingWindow {
  started_at: string;
  ended_at: string | null;
  layer: string | null;
  player_count_at_start: number | null;
}

/** A single planned occurrence of a `seed_schedule` entry, expanded onto the calendar's time axis. */
export interface ScheduleOccurrence {
  entryId: string;
  startsAt: Date;
  seedLayer: string;
  broadcastText: string | null;
  /** Null for a one-off entry's own occurrence; the entry's cron expression otherwise. */
  recurrence: string | null;
}

/**
 * Expands every enabled entry into its concrete occurrences within
 * `[rangeFrom, rangeTo]` (both UTC instants) — a one-off entry contributes at
 * most one occurrence (its own `starts_at`, if inside the range); a
 * recurring entry contributes one occurrence per matching cron minute at or
 * after its `starts_at` (never before it, even if the range starts earlier).
 * Disabled entries are excluded entirely. Returned sorted earliest-first.
 */
export function expandOccurrences(
  entries: readonly SeedScheduleEntry[],
  rangeFrom: Date,
  rangeTo: Date,
): ScheduleOccurrence[] {
  const occurrences: ScheduleOccurrence[] = [];

  for (const entry of entries) {
    if (!entry.enabled) continue;
    const startsAt = new Date(entry.starts_at);

    if (entry.recurrence === null) {
      if (startsAt.getTime() >= rangeFrom.getTime() && startsAt.getTime() <= rangeTo.getTime()) {
        occurrences.push({
          entryId: entry.id,
          startsAt,
          seedLayer: entry.seed_layer,
          broadcastText: entry.broadcast_text,
          recurrence: null,
        });
      }
      continue;
    }

    const scanFrom = new Date(Math.max(rangeFrom.getTime(), startsAt.getTime()));
    if (scanFrom.getTime() > rangeTo.getTime()) continue;
    for (const occurrence of expandCron5Occurrences(entry.recurrence, scanFrom, rangeTo)) {
      occurrences.push({
        entryId: entry.id,
        startsAt: occurrence,
        seedLayer: entry.seed_layer,
        broadcastText: entry.broadcast_text,
        recurrence: entry.recurrence,
      });
    }
  }

  return occurrences.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Monday 00:00 UTC of the week containing `date`. */
export function startOfWeekUtc(date: Date): Date {
  const midnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = midnight.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  midnight.setUTCDate(midnight.getUTCDate() - daysSinceMonday);
  return midnight;
}

/** The 7 UTC midnights (Mon–Sun) of the week starting at `weekStart`. */
export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(weekStart.getTime());
    day.setUTCDate(day.getUTCDate() + i);
    return day;
  });
}

/** `YYYY-MM-DD` UTC calendar-day key for grid bucketing. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Groups items into a `YYYY-MM-DD` (UTC) -> items map, using `getDate` to extract each item's instant. */
export function bucketByDay<T>(items: readonly T[], getDate: (item: T) => Date): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = dayKey(getDate(item));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return buckets;
}
