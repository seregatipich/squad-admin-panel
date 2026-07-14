/** One row from the ROT-4 rotation schedule API. */
export interface RotationScheduleEntry {
  id: string;
  server_id: string;
  scheduled_at: string;
  layer: string;
  mode: 'set_next' | 'force_change';
  enabled: boolean;
  created_by: string | null;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A played match projected onto the rotation calendar. */
export interface RotationHistoryEntry {
  id: string;
  map: string | null;
  layer: string | null;
  winner: string | null;
  is_seed: boolean;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
}

/** A named default or weekday-specific managed rotation profile. */
export interface RotationProfile {
  id: string;
  server_id: string;
  name: string;
  weekday: number | null;
  layers: string[];
  created_by: string | null;
  last_applied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RotationWarning {
  type: 'seed_schedule_overlap' | 'depot_update_window';
  message: string;
  seed_schedule_id?: string;
  seed_layer?: string;
  starts_at?: string;
}

/** Monday 00:00 UTC of the week containing `date`. */
export function startOfWeekUtc(date: Date): Date {
  const midnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = midnight.getUTCDay();
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  midnight.setUTCDate(midnight.getUTCDate() - daysSinceMonday);
  return midnight;
}

/** The seven UTC midnights beginning at `weekStart`. */
export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(weekStart.getTime());
    day.setUTCDate(day.getUTCDate() + index);
    return day;
  });
}

/** UTC `YYYY-MM-DD` key used for calendar buckets. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Buckets calendar items by their UTC day. */
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

/** Filters one-off entries to the currently rendered UTC range. */
export function entriesInRange(
  entries: readonly RotationScheduleEntry[],
  from: Date,
  to: Date,
): RotationScheduleEntry[] {
  return entries.filter((entry) => {
    if (!entry.enabled) return false;
    const timestamp = Date.parse(entry.scheduled_at);
    return timestamp >= from.getTime() && timestamp <= to.getTime();
  });
}

/** Formats an instant for the UTC `datetime-local` control used by the planner. */
export function toDatetimeLocalValue(date: Date): string {
  return date.toISOString().slice(0, 16);
}
