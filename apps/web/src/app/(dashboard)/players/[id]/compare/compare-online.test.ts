import { describe, expect, it } from 'vitest';
import {
  buildCompareWeekGrid,
  type CompareSession,
  nextWeekEndDay,
  prevWeekEndDay,
  summaryLabel,
} from './compare-online';

const WEEK_START = Date.parse('2026-06-29T00:00:00.000Z'); // week ending 2026-07-05
const NOW = Date.parse('2026-07-10T00:00:00.000Z'); // well after the week

function session(id: string, connectedAt: string, disconnectedAt: string | null): CompareSession {
  return {
    id,
    server_id: 'srv-1',
    server_name: 'Server',
    server_slug: 'server',
    mode: 'online',
    connected_at: connectedAt,
    disconnected_at: disconnectedAt,
  };
}

describe('buildCompareWeekGrid', () => {
  it('produces 7 days x 24 hour cells', () => {
    const grid = buildCompareWeekGrid([], [], WEEK_START, NOW);
    expect(grid.days).toHaveLength(7);
    for (const row of grid.cells) {
      expect(row).toHaveLength(24);
    }
  });

  it('reports overlapSeconds 3600 for a cell where both players were online the full hour', () => {
    const a = [session('a1', '2026-07-01T10:00:00.000Z', '2026-07-01T11:00:00.000Z')];
    const b = [session('b1', '2026-07-01T10:00:00.000Z', '2026-07-01T11:00:00.000Z')];
    const grid = buildCompareWeekGrid(a, b, WEEK_START, NOW);
    const dayIndex = Math.round((Date.parse('2026-07-01T00:00:00.000Z') - WEEK_START) / 86_400_000);
    const cell = grid.cells[dayIndex][10];
    expect(cell.aSeconds).toBe(3600);
    expect(cell.bSeconds).toBe(3600);
    expect(cell.overlapSeconds).toBe(3600);
  });

  it('has zero overlap on an A-only cell', () => {
    const a = [session('a1', '2026-07-01T10:00:00.000Z', '2026-07-01T11:00:00.000Z')];
    const grid = buildCompareWeekGrid(a, [], WEEK_START, NOW);
    const dayIndex = Math.round((Date.parse('2026-07-01T00:00:00.000Z') - WEEK_START) / 86_400_000);
    const cell = grid.cells[dayIndex][10];
    expect(cell.aSeconds).toBe(3600);
    expect(cell.bSeconds).toBe(0);
    expect(cell.overlapSeconds).toBe(0);
  });

  it('has zero overlap on a B-only cell', () => {
    const b = [session('b1', '2026-07-01T10:00:00.000Z', '2026-07-01T11:00:00.000Z')];
    const grid = buildCompareWeekGrid([], b, WEEK_START, NOW);
    const dayIndex = Math.round((Date.parse('2026-07-01T00:00:00.000Z') - WEEK_START) / 86_400_000);
    const cell = grid.cells[dayIndex][10];
    expect(cell.aSeconds).toBe(0);
    expect(cell.bSeconds).toBe(3600);
    expect(cell.overlapSeconds).toBe(0);
  });

  it('reports partial overlap when sessions partially overlap within the hour', () => {
    const a = [session('a1', '2026-07-01T10:00:00.000Z', '2026-07-01T10:30:00.000Z')];
    const b = [session('b1', '2026-07-01T10:15:00.000Z', '2026-07-01T10:45:00.000Z')];
    const grid = buildCompareWeekGrid(a, b, WEEK_START, NOW);
    const dayIndex = Math.round((Date.parse('2026-07-01T00:00:00.000Z') - WEEK_START) / 86_400_000);
    const cell = grid.cells[dayIndex][10];
    expect(cell.overlapSeconds).toBe(15 * 60);
  });

  it('does not count touching endpoints as overlap', () => {
    const a = [session('a1', '2026-07-01T10:00:00.000Z', '2026-07-01T10:30:00.000Z')];
    const b = [session('b1', '2026-07-01T10:30:00.000Z', '2026-07-01T10:45:00.000Z')];
    const grid = buildCompareWeekGrid(a, b, WEEK_START, NOW);
    const dayIndex = Math.round((Date.parse('2026-07-01T00:00:00.000Z') - WEEK_START) / 86_400_000);
    const cell = grid.cells[dayIndex][10];
    expect(cell.overlapSeconds).toBe(0);
  });
});

describe('summaryLabel', () => {
  it('formats a 1h30m overlap with 2 concurrent intervals', () => {
    expect(summaryLabel(90 * 60, 2)).toBe(
      'Совместный онлайн за период: 1ч 30м · одновременных заходов: 2',
    );
  });

  it('formats zero overlap', () => {
    expect(summaryLabel(0, 0)).toBe('Совместный онлайн за период: 0м · одновременных заходов: 0');
  });
});

describe('week navigation day-key math', () => {
  it('prevWeekEndDay moves back exactly 7 days', () => {
    expect(prevWeekEndDay('2026-07-05')).toBe('2026-06-28');
  });

  it('nextWeekEndDay moves forward exactly 7 days', () => {
    expect(nextWeekEndDay('2026-07-05')).toBe('2026-07-12');
  });

  it('prevWeekEndDay and nextWeekEndDay are inverses', () => {
    expect(nextWeekEndDay(prevWeekEndDay('2026-07-05'))).toBe('2026-07-05');
  });
});
