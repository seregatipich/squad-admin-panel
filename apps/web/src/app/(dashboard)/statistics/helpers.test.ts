import { describe, expect, it } from 'vitest';
import {
  buildStatisticsQuery,
  chartRows,
  drillDownHref,
  formatMetric,
  hourLabel,
  presetRange,
  RANGE_PRESETS,
  type StatisticsSeries,
  stackedTotal,
  weekdayLabel,
} from './helpers';

const A = '019e0000-0000-7000-8000-0000000000a1';
const B = '019e0000-0000-7000-8000-0000000000b2';
const NOW = new Date('2026-07-15T09:30:00.000Z'); // a Wednesday

function series(): StatisticsSeries {
  return {
    by_server: [
      {
        server_id: A,
        points: [
          { key: '2026-07-01', value: 10 },
          { key: '2026-07-02', value: 4 },
        ],
      },
      {
        server_id: B,
        points: [
          { key: '2026-07-01', value: 5 },
          { key: '2026-07-02', value: 1 },
        ],
      },
    ],
    totals: [
      { key: '2026-07-01', value: 15 },
      { key: '2026-07-02', value: 5 },
    ],
    kpi: { avg: 10, max: 15, total: 20 },
  };
}

describe('RANGE_PRESETS', () => {
  it('offers today, yesterday, week, month, 30 days and a custom range', () => {
    expect(RANGE_PRESETS.map((p) => p.value)).toEqual([
      'today',
      'yesterday',
      'week',
      'month',
      '30days',
      'custom',
    ]);
  });

  it('labels every preset in Russian', () => {
    for (const preset of RANGE_PRESETS) expect(preset.label.length).toBeGreaterThan(0);
    expect(RANGE_PRESETS[0]?.label).toBe('Сегодня');
    expect(RANGE_PRESETS[5]?.label).toBe('Произвольно');
  });
});

describe('presetRange', () => {
  it('bounds "today" by the start of the UTC day and the current instant', () => {
    expect(presetRange('today', NOW, '', '')).toEqual({
      from: '2026-07-15T00:00:00.000Z',
      to: '2026-07-15T09:30:00.000Z',
    });
  });

  it('bounds "yesterday" by that whole UTC day', () => {
    const range = presetRange('yesterday', NOW, '', '');
    expect(range.from).toBe('2026-07-14T00:00:00.000Z');
    expect(range.to).toBe('2026-07-14T23:59:59.999Z');
  });

  it('spans seven days for "week", inclusive of today', () => {
    expect(presetRange('week', NOW, '', '').from).toBe('2026-07-09T00:00:00.000Z');
  });

  it('starts "month" on the first day of the current UTC month', () => {
    expect(presetRange('month', NOW, '', '').from).toBe('2026-07-01T00:00:00.000Z');
  });

  it('spans thirty days for "30days", inclusive of today', () => {
    expect(presetRange('30days', NOW, '', '').from).toBe('2026-06-16T00:00:00.000Z');
  });

  it('uses the supplied day inputs for "custom"', () => {
    expect(presetRange('custom', NOW, '2026-05-01', '2026-05-03')).toEqual({
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-03T23:59:59.999Z',
    });
  });

  it('falls back to the last 30 days when a custom bound is missing or malformed', () => {
    expect(presetRange('custom', NOW, '', '2026-05-03').from).toBe('2026-06-16T00:00:00.000Z');
    expect(presetRange('custom', NOW, 'not-a-day', '2026-05-03').from).toBe(
      '2026-06-16T00:00:00.000Z',
    );
  });
});

describe('buildStatisticsQuery', () => {
  it('carries the window bounds', () => {
    expect(buildStatisticsQuery({ from: 'F', to: 'T', servers: [] })).toBe('?from=F&to=T');
  });

  it('joins the selected servers into a CSV parameter', () => {
    expect(buildStatisticsQuery({ from: 'F', to: 'T', servers: [A, B] })).toBe(
      `?from=F&to=T&servers=${A}%2C${B}`,
    );
  });

  it('omits the server filter when nothing is selected (meaning "all")', () => {
    expect(buildStatisticsQuery({ from: 'F', to: 'T', servers: [] })).not.toContain('servers=');
  });

  it('appends the export format when asked', () => {
    expect(buildStatisticsQuery({ from: 'F', to: 'T', servers: [], format: 'csv' })).toContain(
      'format=csv',
    );
  });

  it('omits absent bounds entirely', () => {
    expect(buildStatisticsQuery({ servers: [] })).toBe('');
  });
});

describe('stackedTotal', () => {
  it('sums every per-server point — the stacked-bar invariant behind KPI.total', () => {
    expect(stackedTotal(series())).toBe(20);
    expect(stackedTotal(series())).toBe(series().kpi.total);
  });

  it('is zero for an empty series', () => {
    expect(stackedTotal({ by_server: [], totals: [], kpi: { avg: 0, max: 0, total: 0 } })).toBe(0);
  });
});

describe('chartRows', () => {
  it('pivots the per-server series into one recharts row per key', () => {
    expect(chartRows(series(), [A, B])).toEqual([
      { key: '2026-07-01', [A]: 10, [B]: 5 },
      { key: '2026-07-02', [A]: 4, [B]: 1 },
    ]);
  });

  it('zero-fills a server that has no point for a key', () => {
    const sparse: StatisticsSeries = {
      by_server: [{ server_id: A, points: [{ key: 'k1', value: 3 }] }],
      totals: [{ key: 'k1', value: 3 }],
      kpi: { avg: 3, max: 3, total: 3 },
    };
    expect(chartRows(sparse, [A, B])).toEqual([{ key: 'k1', [A]: 3, [B]: 0 }]);
  });

  it('keeps each row summing to the stacked total for that key', () => {
    const rows = chartRows(series(), [A, B]);
    const totals = series().totals;
    rows.forEach((row, index) => {
      const stacked = [A, B].reduce((sum, id) => sum + (row[id] as number), 0);
      expect(stacked).toBe(totals[index]?.value);
    });
  });

  it('returns an empty list when the series has no keys', () => {
    expect(
      chartRows({ by_server: [], totals: [], kpi: { avg: 0, max: 0, total: 0 } }, [A]),
    ).toEqual([]);
  });
});

describe('formatMetric', () => {
  it('prints whole numbers without a decimal part', () => {
    expect(formatMetric(20)).toBe('20');
  });

  it('keeps one decimal for fractional values, comma-separated', () => {
    expect(formatMetric(0.3)).toBe('0,3');
    expect(formatMetric(12.55)).toBe('12,6');
  });

  it('prints a dash for a missing value', () => {
    expect(formatMetric(Number.NaN)).toBe('—');
  });
});

describe('hourLabel / weekdayLabel', () => {
  it('renders hour buckets as a wall-clock hour', () => {
    expect(hourLabel('00')).toBe('00:00');
    expect(hourLabel('23')).toBe('23:00');
  });

  it('renders ISO weekday buckets in Russian, Monday first', () => {
    expect(weekdayLabel('1')).toBe('Пн');
    expect(weekdayLabel('7')).toBe('Вс');
  });

  it('passes an unknown weekday key through unchanged', () => {
    expect(weekdayLabel('9')).toBe('9');
  });
});

describe('drillDownHref', () => {
  it('sends population and match bars to the events list, filtered to that day', () => {
    expect(drillDownHref('events', A, '2026-07-04')).toBe(
      `/events?servers=${A}&preset=custom&from=2026-07-04&to=2026-07-04`,
    );
  });

  it('sends chat bars to the chat archive with its own date parameters', () => {
    expect(drillDownHref('chat', A, '2026-07-04')).toBe(
      `/chat?server=${A}&from=2026-07-04&to=2026-07-04`,
    );
  });

  it('sends teamkill bars to the combat log on the teamkill facet', () => {
    expect(drillDownHref('combat-log', A, '2026-07-04')).toBe(
      `/combat-log?server=${A}&facet=teamkills&preset=custom&from=2026-07-04&to=2026-07-04`,
    );
  });

  it('sends punishment bars to the external bans list', () => {
    // /external-bans parses neither a server nor a date filter today, so the
    // link is intentionally bare rather than carrying parameters it ignores.
    expect(drillDownHref('external-bans', A, '2026-07-04')).toBe('/external-bans');
  });

  it('drops the day when the bar is not day-keyed (hour/weekday buckets)', () => {
    expect(drillDownHref('events', A, null)).toBe(`/events?servers=${A}`);
    expect(drillDownHref('chat', A, null)).toBe(`/chat?server=${A}`);
  });
});
