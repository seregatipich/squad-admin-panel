import { describe, expect, it } from 'vitest';
import {
  excerpt,
  formatReportDate,
  REPORT_STATUS_BADGE_CLASSES,
  REPORT_STATUS_LABELS,
} from './reports-summary';

describe('excerpt', () => {
  it('returns the body unchanged when shorter than the limit', () => {
    expect(excerpt('Cheating on the server')).toBe('Cheating on the server');
  });

  it('truncates long bodies with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const result = excerpt(long, 10);
    expect(result).toBe(`${'a'.repeat(10)}…`);
  });

  it('trims surrounding whitespace', () => {
    expect(excerpt('  Cheating  ')).toBe('Cheating');
  });
});

describe('formatReportDate', () => {
  it('renders a dash for null/invalid input', () => {
    expect(formatReportDate(null)).toBe('—');
    expect(formatReportDate('not-a-date')).toBe('—');
  });

  it('formats a valid ISO timestamp', () => {
    expect(formatReportDate('2026-07-09T12:30:00.000Z')).not.toBe('—');
  });
});

describe('REPORT_STATUS_LABELS / REPORT_STATUS_BADGE_CLASSES', () => {
  it('covers every report status', () => {
    const statuses = ['pending', 'in_review', 'resolved', 'rejected'] as const;
    for (const status of statuses) {
      expect(REPORT_STATUS_LABELS[status]).toBeTruthy();
      expect(REPORT_STATUS_BADGE_CLASSES[status]).toBeTruthy();
    }
  });
});
