import { describe, expect, it } from 'vitest';
import {
  type AppealStatus,
  allowedTransitions,
  appealNumberLabel,
  buildApiQuery,
  buildQueryString,
  formatDateTime,
  isTerminal,
  PAGE_SIZE,
  parseFilters,
  STATUS_BADGE_CLASSES,
  STATUS_FILTERS,
  STATUS_LABELS,
  totalPages,
} from './helpers';

function params(map: Record<string, string>) {
  return { get: (key: string) => map[key] ?? null };
}

describe('parseFilters', () => {
  it('defaults to no status filter on page 1', () => {
    expect(parseFilters(params({}))).toEqual({ status: '', page: 1 });
  });

  it('keeps a known status and a positive page', () => {
    expect(parseFilters(params({ status: 'in_review', page: '3' }))).toEqual({
      status: 'in_review',
      page: 3,
    });
  });

  it('drops an unknown status and a non-positive page', () => {
    expect(parseFilters(params({ status: 'resolved', page: '0' }))).toEqual({
      status: '',
      page: 1,
    });
    expect(parseFilters(params({ page: 'abc' }))).toEqual({ status: '', page: 1 });
  });
});

describe('buildQueryString', () => {
  it('omits defaults', () => {
    expect(buildQueryString({ status: '', page: 1 })).toBe('');
  });

  it('includes a status and a page beyond the first', () => {
    expect(buildQueryString({ status: 'approved', page: 2 })).toBe('status=approved&page=2');
  });
});

describe('buildApiQuery', () => {
  it('always sends page and page_size', () => {
    expect(buildApiQuery({ status: '', page: 1 })).toBe(`page=1&page_size=${PAGE_SIZE}`);
  });

  it('adds the status filter when set', () => {
    expect(buildApiQuery({ status: 'pending', page: 2 }, 50)).toBe(
      'status=pending&page=2&page_size=50',
    );
  });
});

describe('totalPages', () => {
  it('returns 1 for an empty queue', () => {
    expect(totalPages(0)).toBe(1);
  });

  it('rounds up partial pages', () => {
    expect(totalPages(21, 20)).toBe(2);
    expect(totalPages(40, 20)).toBe(2);
  });
});

describe('formatDateTime', () => {
  it('renders an em dash for null and for an unparsable value', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });

  it('renders a Russian date for a valid ISO string', () => {
    expect(formatDateTime('2026-07-20T10:00:00.000Z')).toMatch(/2026/);
  });
});

describe('isTerminal', () => {
  it('marks approved and rejected as terminal', () => {
    expect(isTerminal('approved')).toBe(true);
    expect(isTerminal('rejected')).toBe(true);
  });

  it('marks pending and in_review as open', () => {
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('in_review')).toBe(false);
  });
});

describe('allowedTransitions', () => {
  it('mirrors the API transition table', () => {
    expect(allowedTransitions('pending')).toEqual(['in_review', 'approved', 'rejected']);
    expect(allowedTransitions('in_review')).toEqual(['approved', 'rejected']);
    expect(allowedTransitions('approved')).toEqual([]);
    expect(allowedTransitions('rejected')).toEqual([]);
  });
});

describe('appealNumberLabel', () => {
  it('prefixes the queue number with a hash', () => {
    expect(appealNumberLabel(12)).toBe('#12');
  });
});

describe('status label tables', () => {
  it('labels and styles every status', () => {
    const statuses: AppealStatus[] = ['pending', 'in_review', 'approved', 'rejected'];
    for (const status of statuses) {
      expect(STATUS_LABELS[status]).toBeTruthy();
      expect(STATUS_BADGE_CLASSES[status]).toContain('border');
    }
  });

  it('offers an "all" option plus one filter per status', () => {
    expect(STATUS_FILTERS[0]).toEqual({ value: '', label: 'Все' });
    expect(STATUS_FILTERS).toHaveLength(5);
  });
});
