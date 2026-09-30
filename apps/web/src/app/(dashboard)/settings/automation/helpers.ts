/**
 * Pure helpers for the AUTO-1 (#72) automation-rules page's "Test" (dry-run)
 * action, split out from `page.tsx` so the sample-building logic is testable
 * without mounting the page (mirrors `settings/alt-detection/helpers.ts`).
 */

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Weekday (0=Sun) and the local-minus-UTC offset (minutes) of `date` in `timeZone`. */
function zoneInfo(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; weekday: number; offsetMinutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const asUtc = Date.UTC(
    year,
    month - 1,
    day,
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  return {
    year,
    month,
    day,
    weekday: WEEKDAY_INDEX[map.weekday ?? ''] ?? 0,
    offsetMinutes: (asUtc - date.getTime()) / 60_000,
  };
}

/**
 * Picks a timestamp that actually falls inside the rule's configured window
 * (mirrors `matchTimeOfDay` in `@squad/shared-types`'s automation engine),
 * instead of the raw current time — a sample whose match outcome depended on
 * the wall-clock time the operator happened to click "Test" at (#677).
 *
 * `referenceNow` defaults to the real current time; tests pin it to make the
 * window search deterministic.
 */
export function sampleTimeOfDay(
  condition: Record<string, unknown>,
  referenceNow: Date = new Date(),
): string {
  const timezone = typeof condition.timezone === 'string' ? condition.timezone : 'UTC';
  const startMinute = Number(condition.startMinute ?? 0);
  const weekdays = Array.isArray(condition.weekdays)
    ? (condition.weekdays as unknown[]).filter((w): w is number => typeof w === 'number')
    : null;

  let info: ReturnType<typeof zoneInfo>;
  try {
    info = zoneInfo(referenceNow, timezone);
  } catch {
    return referenceNow.toISOString();
  }

  let dayOffset = 0;
  if (weekdays && weekdays.length > 0) {
    for (let delta = 0; delta < 7; delta++) {
      if (weekdays.includes((info.weekday + delta) % 7)) {
        dayOffset = delta;
        break;
      }
    }
  }

  const zonedMidnightAsUtc = Date.UTC(info.year, info.month - 1, info.day + dayOffset);
  const targetMs = zonedMidnightAsUtc + startMinute * 60_000 - info.offsetMinutes * 60_000;
  return new Date(targetMs).toISOString();
}

/** Builds the dry-run trigger payload for `POST /api/v1/automation-rules/:id/test`. */
export function sampleFor(
  conditionType: string,
  condition: Record<string, unknown>,
  referenceNow?: Date,
): Record<string, unknown> {
  switch (conditionType) {
    case 'chat_keyword':
      return {
        chat_message: String(condition.keyword ?? ''),
        player: { steam_id64: '76561190000000001', name: 'DryRunPlayer' },
      };
    case 'player_count': {
      const threshold = Number(condition.threshold ?? 0);
      const operator = condition.operator;
      // gt/lt at exactly `threshold` never matches — offset the sample by
      // one so the dry-run reflects the operator, not just the number.
      const playerCount =
        operator === 'gt'
          ? threshold + 1
          : operator === 'lt'
            ? Math.max(threshold - 1, 0)
            : threshold;
      return { player_count: playerCount };
    }
    case 'time_of_day':
      return { now: sampleTimeOfDay(condition, referenceNow) };
    case 'player_flag': {
      const flag = String(condition.flag ?? '');
      // `present: false` conditions match when the flag is ABSENT; a sample
      // that always includes the flag could never demonstrate that case.
      const present = condition.present !== false;
      return {
        player_flags: present ? [flag] : [],
        player: { steam_id64: '76561190000000001', name: 'DryRunPlayer' },
      };
    }
    default:
      return {};
  }
}
