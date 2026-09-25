// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { entriesInRange, startOfWeekUtc } from './helpers';

afterEach(() => cleanup());

describe('rotation calendar helpers', () => {
  it('starts weeks on Monday in UTC', () => {
    expect(startOfWeekUtc(new Date('2026-07-15T18:00:00Z')).toISOString()).toBe(
      '2026-07-13T00:00:00.000Z',
    );
  });

  it('filters disabled entries and entries outside the visible week', () => {
    const from = new Date('2026-07-13T00:00:00Z');
    const to = new Date('2026-07-19T23:59:00Z');
    expect(
      entriesInRange(
        [
          {
            id: 'inside',
            server_id: 'server',
            scheduled_at: '2026-07-14T10:00:00Z',
            layer: 'Narva Seed v1',
            mode: 'set_next',
            enabled: true,
            created_by: null,
            last_executed_at: null,
            created_at: '',
            updated_at: '',
          },
          {
            id: 'disabled',
            server_id: 'server',
            scheduled_at: '2026-07-14T11:00:00Z',
            layer: 'Gorodok RAAS v1',
            mode: 'force_change',
            enabled: false,
            created_by: null,
            last_executed_at: null,
            created_at: '',
            updated_at: '',
          },
        ],
        from,
        to,
      ).map((entry) => entry.id),
    ).toEqual(['inside']);
  });
});
