import { describe, expect, it } from 'vitest';

function partitionName(year: number, month: number): string {
  const mm = String(month).padStart(2, '0');
  return `events_${year}_${mm}`;
}

function nextMonthPartition(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return partitionName(next.getUTCFullYear(), next.getUTCMonth() + 1);
}

function currentMonthPartition(now: Date): string {
  return partitionName(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

describe('partition name computation', () => {
  it('generates correct partition name for a given year/month', () => {
    expect(partitionName(2026, 4)).toBe('events_2026_04');
    expect(partitionName(2026, 12)).toBe('events_2026_12');
    expect(partitionName(2025, 1)).toBe('events_2025_01');
  });

  it('computes next month partition rolling over December into January', () => {
    const dec = new Date('2025-12-15T00:00:00Z');
    expect(nextMonthPartition(dec)).toBe('events_2026_01');
  });

  it('computes next month partition for a regular month', () => {
    const apr = new Date('2026-04-25T00:00:00Z');
    expect(nextMonthPartition(apr)).toBe('events_2026_05');
  });

  it('current month partition is distinct from next month', () => {
    const now = new Date('2026-04-25T00:00:00Z');
    expect(currentMonthPartition(now)).toBe('events_2026_04');
    expect(nextMonthPartition(now)).toBe('events_2026_05');
  });
});
