import { describe, expect, it } from 'vitest';
import { priorityBadge } from './helpers';

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
