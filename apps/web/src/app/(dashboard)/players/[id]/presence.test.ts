import { describe, expect, it } from 'vitest';
import {
  bonusValueSeconds,
  buildWeekGrid,
  cellBackground,
  cellFillFraction,
  dayRowLabel,
  dominantMode,
  fmtDuration,
  type PresenceSession,
  type ServerPresence,
  serverLabel,
  sortServersByOnline,
  weekStartMsForEndDay,
} from './presence';

const WEEK_START = Date.parse('2026-06-29T00:00:00.000Z');

function session(overrides: Partial<PresenceSession> = {}): PresenceSession {
  return {
    id: '1',
    server_id: 's1',
    server_name: 'EU',
    server_slug: 'eu-1',
    mode: 'online',
    connected_at: '2026-06-29T10:00:00.000Z',
    disconnected_at: '2026-06-29T11:00:00.000Z',
    ...overrides,
  };
}

describe('bonusValueSeconds', () => {
  it('applies the default formula online + 2×boost and ignores queue', () => {
    expect(bonusValueSeconds({ online_seconds: 100, boost_seconds: 50, queue_seconds: 999 })).toBe(
      200,
    );
    expect(bonusValueSeconds({ online_seconds: 0, boost_seconds: 0, queue_seconds: 0 })).toBe(0);
  });
});

describe('weekStartMsForEndDay', () => {
  it('places the window start six days before the (inclusive) end day at UTC midnight', () => {
    expect(weekStartMsForEndDay('2026-07-05')).toBe(Date.parse('2026-06-29T00:00:00.000Z'));
  });
});

describe('dominantMode', () => {
  it('returns null for an empty cell', () => {
    expect(
      dominantMode({ online_seconds: 0, boost_seconds: 0, queue_seconds: 0, seed_seconds: 0 }),
    ).toBeNull();
  });
  it('prefers boost on ties, then queue, then online', () => {
    expect(
      dominantMode({ online_seconds: 60, boost_seconds: 60, queue_seconds: 0, seed_seconds: 0 }),
    ).toBe('boost');
    expect(
      dominantMode({ online_seconds: 60, boost_seconds: 0, queue_seconds: 60, seed_seconds: 0 }),
    ).toBe('queue');
    expect(
      dominantMode({ online_seconds: 60, boost_seconds: 0, queue_seconds: 0, seed_seconds: 0 }),
    ).toBe('online');
    expect(
      dominantMode({ online_seconds: 10, boost_seconds: 100, queue_seconds: 50, seed_seconds: 0 }),
    ).toBe('boost');
  });
});

describe('buildWeekGrid', () => {
  const nowMs = Date.parse('2026-07-05T12:00:00.000Z');

  it('lays out 7 rows of 24 hourly cells labelled by UTC day', () => {
    const grid = buildWeekGrid([], WEEK_START, nowMs);
    expect(grid.days).toEqual([
      '2026-06-29',
      '2026-06-30',
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
    ]);
    expect(grid.cells).toHaveLength(7);
    for (const row of grid.cells) expect(row).toHaveLength(24);
  });

  it('buckets a one-hour session into a single cell with its mode', () => {
    const grid = buildWeekGrid([session({ mode: 'boost' })], WEEK_START, nowMs);
    const cell = grid.cells[0]?.[10];
    if (!cell) throw new Error('expected a cell at day 0 hour 10');
    expect(cell.boost_seconds).toBe(3600);
    expect(cell.total_seconds).toBe(3600);
    expect(cell.mode).toBe('boost');
    expect(cellFillFraction(cell)).toBe(1);
  });

  it('renders a seed session with the dedicated seed mode and color', () => {
    const grid = buildWeekGrid([session({ mode: 'seed' })], WEEK_START, nowMs);
    const cell = grid.cells[0]?.[10];
    if (!cell) throw new Error('expected a cell at day 0 hour 10');
    expect(cell.seed_seconds).toBe(3600);
    expect(cell.mode).toBe('seed');
    expect(cellBackground(cell)).toMatch(/^#[0-9a-f]{8}$/i);
  });

  it('splits a session that spans an hour boundary across two cells', () => {
    const grid = buildWeekGrid(
      [
        session({
          connected_at: '2026-06-30T09:30:00.000Z',
          disconnected_at: '2026-06-30T10:30:00.000Z',
        }),
      ],
      WEEK_START,
      nowMs,
    );
    expect(grid.cells[1]?.[9]?.online_seconds).toBe(1800);
    expect(grid.cells[1]?.[10]?.online_seconds).toBe(1800);
  });

  it('clamps an open session to now and to the week window', () => {
    const grid = buildWeekGrid(
      [
        session({
          connected_at: '2026-06-20T00:00:00.000Z',
          disconnected_at: null,
        }),
      ],
      WEEK_START,
      Date.parse('2026-06-29T02:00:00.000Z'),
    );
    expect(grid.cells[0]?.[0]?.online_seconds).toBe(3600);
    expect(grid.cells[0]?.[1]?.online_seconds).toBe(3600);
    expect(grid.cells[0]?.[2]?.online_seconds).toBe(0);
  });

  it('ignores sessions entirely outside the window', () => {
    const grid = buildWeekGrid(
      [
        session({
          connected_at: '2026-05-01T10:00:00.000Z',
          disconnected_at: '2026-05-01T11:00:00.000Z',
        }),
      ],
      WEEK_START,
      nowMs,
    );
    const total = grid.cells.flat().reduce((sum, cell) => sum + cell.total_seconds, 0);
    expect(total).toBe(0);
  });
});

describe('sortServersByOnline', () => {
  it('orders servers by online seconds descending, then by label', () => {
    const servers: ServerPresence[] = [
      base({ server_id: 'a', server_slug: 'a', online_seconds: 100 }),
      base({ server_id: 'b', server_slug: 'b', online_seconds: 300 }),
      base({ server_id: 'c', server_slug: 'c', online_seconds: 300 }),
    ];
    expect(sortServersByOnline(servers).map((s) => s.server_id)).toEqual(['b', 'c', 'a']);
  });
});

describe('serverLabel', () => {
  it('prefers slug, then name, then dash', () => {
    expect(serverLabel({ server_slug: 'eu', server_name: 'EU Main' })).toBe('eu');
    expect(serverLabel({ server_slug: null, server_name: 'EU Main' })).toBe('EU Main');
    expect(serverLabel({ server_slug: null, server_name: null })).toBe('—');
  });
});

describe('fmtDuration', () => {
  it('formats hours, minutes, seconds and guards non-positive input', () => {
    expect(fmtDuration(3661)).toBe('1ч 1м');
    expect(fmtDuration(120)).toBe('2м');
    expect(fmtDuration(42)).toBe('42с');
    expect(fmtDuration(0)).toBe('0м');
    expect(fmtDuration(-5)).toBe('0м');
  });
});

describe('dayRowLabel', () => {
  it('renders weekday and MM-DD in UTC', () => {
    expect(dayRowLabel('2026-06-29')).toBe('Пн 06-29');
    expect(dayRowLabel('2026-07-05')).toBe('Вс 07-05');
  });
});

function base(overrides: Partial<ServerPresence>): ServerPresence {
  return {
    server_id: 's',
    server_name: null,
    server_slug: null,
    online_seconds: 0,
    boost_seconds: 0,
    queue_seconds: 0,
    session_count: 0,
    ...overrides,
  };
}
