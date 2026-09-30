import { describe, expect, it } from 'vitest';
import { resolveCronDueOccurrence } from '../src/due-occurrence.js';

const base = {
  recurrence: null,
  oneOffAt: null,
  lastExecutedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('resolveCronDueOccurrence', () => {
  it('fires a one-off once it is due and never again', () => {
    const oneOffAt = new Date('2026-07-11T10:00:00.000Z');
    const now = new Date('2026-07-11T10:00:01.000Z');
    expect(resolveCronDueOccurrence({ ...base, oneOffAt }, now)).toEqual(oneOffAt);
    expect(
      resolveCronDueOccurrence({ ...base, oneOffAt, lastExecutedAt: oneOffAt }, now),
    ).toBeNull();
  });

  it('never fires a one-off without an instant', () => {
    expect(resolveCronDueOccurrence(base, new Date('2027-01-01T00:00:00.000Z'))).toBeNull();
  });

  it('collapses missed occurrences into the most recent one', () => {
    const schedule = { ...base, recurrence: '0 * * * *' };
    expect(resolveCronDueOccurrence(schedule, new Date('2026-01-01T05:30:00.000Z'))).toEqual(
      new Date('2026-01-01T05:00:00.000Z'),
    );
  });

  it('stays due for a rare cron after months of downtime', () => {
    const schedule = {
      ...base,
      recurrence: '0 0 1 1 *',
      lastExecutedAt: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    expect(resolveCronDueOccurrence(schedule, new Date('2027-06-01T00:00:00.000Z'))).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
  });
});
