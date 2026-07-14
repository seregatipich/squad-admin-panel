import { describe, expect, it } from 'vitest';
import { paginate, priorityBadge, sortClans } from './helpers';

describe('priorityBadge', () => {
  const now = new Date('2026-07-14T12:00:00.000Z');

  it('renders «Бессрочно» when there is no expiry', () => {
    expect(priorityBadge(null, now)).toEqual({ label: 'Бессрочно', tone: 'neutral' });
  });

  it('renders «Истёк» for a past deadline', () => {
    expect(priorityBadge('2026-07-01T00:00:00.000Z', now)).toEqual({
      label: 'Истёк',
      tone: 'danger',
    });
  });

  it('renders «Истёк» at the exact boundary (now)', () => {
    expect(priorityBadge(now.toISOString(), now)).toEqual({ label: 'Истёк', tone: 'danger' });
  });

  it('renders «через N дн.» for a future deadline', () => {
    const inFiveDays = new Date(now.getTime() + 5 * 86_400_000).toISOString();
    expect(priorityBadge(inFiveDays, now)).toEqual({ label: 'через 5 дн.', tone: 'warning' });
  });

  it('rounds up a same-day-but-later deadline to 1 day', () => {
    const inOneHour = new Date(now.getTime() + 3_600_000).toISOString();
    expect(priorityBadge(inOneHour, now)).toEqual({ label: 'через 1 дн.', tone: 'warning' });
  });
});

interface FixtureClan {
  name: string;
  member_count: number;
  priority_count: number;
}

const CLANS: FixtureClan[] = [
  { name: 'Браво', member_count: 5, priority_count: 2 },
  { name: 'Альфа', member_count: 10, priority_count: 0 },
  { name: 'Чарли', member_count: 1, priority_count: 5 },
];

describe('sortClans', () => {
  it('sorts by name ascending', () => {
    expect(sortClans(CLANS, 'name', 'asc').map((c) => c.name)).toEqual(['Альфа', 'Браво', 'Чарли']);
  });

  it('sorts by name descending', () => {
    expect(sortClans(CLANS, 'name', 'desc').map((c) => c.name)).toEqual([
      'Чарли',
      'Браво',
      'Альфа',
    ]);
  });

  it('sorts by member count ascending', () => {
    expect(sortClans(CLANS, 'members', 'asc').map((c) => c.member_count)).toEqual([1, 5, 10]);
  });

  it('sorts by member count descending', () => {
    expect(sortClans(CLANS, 'members', 'desc').map((c) => c.member_count)).toEqual([10, 5, 1]);
  });

  it('sorts by priority count ascending', () => {
    expect(sortClans(CLANS, 'priority', 'asc').map((c) => c.priority_count)).toEqual([0, 2, 5]);
  });

  it('sorts by priority count descending', () => {
    expect(sortClans(CLANS, 'priority', 'desc').map((c) => c.priority_count)).toEqual([5, 2, 0]);
  });

  it('does not mutate the input array', () => {
    const copy = [...CLANS];
    sortClans(CLANS, 'name', 'asc');
    expect(CLANS).toEqual(copy);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 100 }, (_, i) => i + 1);

  it('returns the first page of 25 by default', () => {
    const result = paginate(items, 1);
    expect(result.items).toHaveLength(25);
    expect(result.items[0]).toBe(1);
    expect(result.items.at(-1)).toBe(25);
    expect(result.pageCount).toBe(4);
    expect(result.total).toBe(100);
    expect(result.page).toBe(1);
  });

  it('returns a middle page correctly', () => {
    const result = paginate(items, 2);
    expect(result.items[0]).toBe(26);
    expect(result.items.at(-1)).toBe(50);
  });

  it('returns a partial last page', () => {
    const result = paginate(items, 4);
    expect(result.items).toHaveLength(25);
    expect(result.items.at(-1)).toBe(100);
  });

  it('clamps a page below 1 to page 1', () => {
    const result = paginate(items, 0);
    expect(result.page).toBe(1);
    expect(result.items[0]).toBe(1);
  });

  it('clamps a page beyond the last page to the last page', () => {
    const result = paginate(items, 99);
    expect(result.page).toBe(4);
    expect(result.items.at(-1)).toBe(100);
  });

  it('handles an empty list with a single, empty page', () => {
    const result = paginate([], 1);
    expect(result.pageCount).toBe(1);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('respects a custom perPage', () => {
    const result = paginate(items, 1, 10);
    expect(result.items).toHaveLength(10);
    expect(result.pageCount).toBe(10);
  });
});
