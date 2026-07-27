import { describe, expect, it } from 'vitest';
import { MAX_WINDOW_DAYS } from '../src/routes/analytics.js';
import {
  buildSeries,
  dayKeysInWindow,
  HOUR_KEYS,
  parseServerFilter,
  type StatisticsPayload,
  toStatisticsCsv,
  WEEKDAY_KEYS,
  weekdayKeyOf,
} from '../src/routes/statistics.js';

const SERVER_A = '019e0000-0000-7000-8000-0000000009a1';
const SERVER_B = '019e0000-0000-7000-8000-0000000009b2';

describe('parseServerFilter', () => {
  it('returns an empty list when the parameter is absent or blank', () => {
    expect(parseServerFilter(undefined)).toEqual([]);
    expect(parseServerFilter('')).toEqual([]);
    expect(parseServerFilter('   ')).toEqual([]);
  });

  it('splits a CSV of UUIDs and trims surrounding whitespace', () => {
    expect(parseServerFilter(`${SERVER_A}, ${SERVER_B}`)).toEqual([SERVER_A, SERVER_B]);
  });

  it('drops entries that are not UUIDs instead of failing the request', () => {
    expect(parseServerFilter(`${SERVER_A},not-a-uuid,,${SERVER_B}`)).toEqual([SERVER_A, SERVER_B]);
  });

  it('de-duplicates repeated ids', () => {
    expect(parseServerFilter(`${SERVER_A},${SERVER_A}`)).toEqual([SERVER_A]);
  });
});

describe('dayKeysInWindow', () => {
  it('lists every UTC day from `from` through `to`, inclusive', () => {
    expect(
      dayKeysInWindow(new Date('2026-07-01T18:00:00Z'), new Date('2026-07-04T03:00:00Z')),
    ).toEqual(['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
  });

  it('returns a single day when both bounds fall on it', () => {
    expect(
      dayKeysInWindow(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T23:59:59Z')),
    ).toEqual(['2026-07-01']);
  });

  it('returns nothing when `to` precedes `from`', () => {
    expect(
      dayKeysInWindow(new Date('2026-07-04T00:00:00Z'), new Date('2026-07-01T00:00:00Z')),
    ).toEqual([]);
  });

  it('never exceeds the analytics window cap', () => {
    const to = new Date('2026-07-01T00:00:00Z');
    const from = new Date(to.getTime() - 400 * 86_400_000);
    expect(dayKeysInWindow(from, to).length).toBeLessThanOrEqual(MAX_WINDOW_DAYS + 1);
  });
});

describe('weekdayKeyOf', () => {
  it('maps ISO weekdays with Monday as 1 and Sunday as 7', () => {
    expect(weekdayKeyOf('2026-07-06')).toBe('1'); // Monday
    expect(weekdayKeyOf('2026-07-11')).toBe('6'); // Saturday
    expect(weekdayKeyOf('2026-07-12')).toBe('7'); // Sunday
  });
});

describe('buildSeries', () => {
  const keys = ['2026-07-01', '2026-07-02'];
  const values: Record<string, Record<string, number>> = {
    [SERVER_A]: { '2026-07-01': 10, '2026-07-02': 4 },
    [SERVER_B]: { '2026-07-01': 5, '2026-07-02': 1 },
  };
  const series = buildSeries(keys, [SERVER_A, SERVER_B], (id, key) => values[id]?.[key] ?? 0);

  it('emits one dense point per key for every requested server', () => {
    expect(series.by_server).toHaveLength(2);
    for (const entry of series.by_server) {
      expect(entry.points.map((p) => p.key)).toEqual(keys);
    }
  });

  it('stacks per-server points into the daily totals', () => {
    expect(series.totals).toEqual([
      { key: '2026-07-01', value: 15 },
      { key: '2026-07-02', value: 5 },
    ]);
  });

  it('keeps sum(stacked bars) equal to KPI.total', () => {
    const stacked = series.by_server.reduce(
      (sum, entry) => sum + entry.points.reduce((inner, point) => inner + point.value, 0),
      0,
    );
    expect(stacked).toBe(series.kpi.total);
    expect(series.totals.reduce((sum, point) => sum + point.value, 0)).toBe(series.kpi.total);
  });

  it('reports max as the tallest stacked bar and avg over the key count', () => {
    expect(series.kpi.max).toBe(15);
    expect(series.kpi.total).toBe(20);
    expect(series.kpi.avg).toBe(10);
  });

  it('rounds the average to one decimal', () => {
    const odd = buildSeries(['a', 'b', 'c'], [SERVER_A], () => 1);
    expect(odd.kpi.avg).toBe(1);
    const uneven = buildSeries(['a', 'b', 'c'], [SERVER_A], (_id, key) => (key === 'a' ? 1 : 0));
    expect(uneven.kpi.avg).toBe(0.3);
  });

  it('produces zeroed KPIs for an empty key list', () => {
    const empty = buildSeries([], [SERVER_A], () => 7);
    expect(empty.totals).toEqual([]);
    expect(empty.kpi).toEqual({ avg: 0, max: 0, total: 0 });
  });

  it('produces zeroed KPIs when no server is selected', () => {
    const empty = buildSeries(keys, [], () => 7);
    expect(empty.by_server).toEqual([]);
    expect(empty.totals).toEqual([
      { key: '2026-07-01', value: 0 },
      { key: '2026-07-02', value: 0 },
    ]);
    expect(empty.kpi).toEqual({ avg: 0, max: 0, total: 0 });
  });

  it('emits only numbers, never strings', () => {
    for (const entry of series.by_server) {
      for (const point of entry.points) expect(typeof point.value).toBe('number');
    }
    expect(typeof series.kpi.avg).toBe('number');
    expect(typeof series.kpi.max).toBe('number');
    expect(typeof series.kpi.total).toBe('number');
  });
});

describe('bucket key constants', () => {
  it('covers all 24 hours, zero-padded and ordered', () => {
    expect(HOUR_KEYS).toHaveLength(24);
    expect(HOUR_KEYS[0]).toBe('00');
    expect(HOUR_KEYS[23]).toBe('23');
  });

  it('covers all 7 ISO weekdays', () => {
    expect(WEEKDAY_KEYS).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });
});

function samplePayload(): StatisticsPayload {
  const keys = ['2026-07-01'];
  const one = buildSeries(keys, [SERVER_A], () => 3);
  const bucketSeries = (bucketKeys: string[]) => buildSeries(bucketKeys, [SERVER_A], () => 1);
  return {
    from: '2026-07-01T00:00:00.000Z',
    to: '2026-07-01T23:59:59.000Z',
    days: keys,
    servers: [{ server_id: SERVER_A, display_name: 'Server "A", main' }],
    population: {
      avg_online: one,
      peak_online: one,
      avg_queue: one,
      by_hour: bucketSeries(HOUR_KEYS),
      by_weekday: bucketSeries(WEEKDAY_KEYS),
    },
    matches: {
      by_day: one,
      modes: [{ mode: 'AAS', matches: 2 }],
      maps: [{ map: 'Narva', matches: 1 }],
    },
    community: { new_players: one, chat_messages: one, teamkills: one },
    moderation: { punishments: one, avg_admins: one, peak_admins: one },
  };
}

describe('toStatisticsCsv', () => {
  const csv = toStatisticsCsv(samplePayload());
  const rows = csv.trim().split('\r\n');

  it('starts with a stable long-format header', () => {
    expect(rows[0]).toBe('section,metric,server_id,key,value');
  });

  it('uses CRLF line endings per RFC 4180', () => {
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv).not.toMatch(/[^\r]\n/);
  });

  it('quotes fields containing commas and doubles embedded quotes', () => {
    expect(rows).toContain(`meta,server_name,${SERVER_A},,"Server ""A"", main"`);
  });

  it('carries the window bounds as meta rows', () => {
    expect(rows).toContain('meta,from,,,2026-07-01T00:00:00.000Z');
    expect(rows).toContain('meta,to,,,2026-07-01T23:59:59.000Z');
  });

  it('emits one row per server per key for every daily series', () => {
    expect(rows).toContain(`population,avg_online,${SERVER_A},2026-07-01,3`);
    expect(rows).toContain(`community,teamkills,${SERVER_A},2026-07-01,3`);
    expect(rows).toContain(`moderation,peak_admins,${SERVER_A},2026-07-01,3`);
  });

  it('emits the hour and weekday buckets', () => {
    expect(rows.filter((r) => r.startsWith('population,by_hour,'))).toHaveLength(24);
    expect(rows.filter((r) => r.startsWith('population,by_weekday,'))).toHaveLength(7);
  });

  it('emits the mode and map breakdowns', () => {
    expect(rows).toContain('matches,mode,,AAS,2');
    expect(rows).toContain('matches,map,,Narva,1');
  });

  it('emits the KPI triple for every series', () => {
    expect(rows).toContain('kpi,avg_online,,total,3');
    expect(rows).toContain('kpi,avg_online,,max,3');
    expect(rows).toContain('kpi,avg_online,,avg,3');
  });
});
