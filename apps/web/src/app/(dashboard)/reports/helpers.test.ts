import { describe, expect, it } from 'vitest';
import type { ReportEvidenceItem } from '@/lib/live-bus';
import {
  buildApiQuery,
  buildQueryString,
  evidenceBadgeLabel,
  evidenceLabel,
  formatDateTime,
  isExternalLinkEvidence,
  isImageEvidence,
  isVideoEvidence,
  parseFilters,
  playerLabel,
  totalPages,
} from './helpers';

function makeEvidence(overrides: Partial<ReportEvidenceItem> = {}): ReportEvidenceItem {
  return {
    id: 'e1',
    kind: 'image',
    external_url: null,
    original_filename: 'screenshot.png',
    mime_type: 'image/png',
    size_bytes: 100,
    title: null,
    ...overrides,
  };
}

describe('parseFilters', () => {
  it('reads status and page from URL params', () => {
    const params = new URLSearchParams('status=in_review&page=3');
    expect(parseFilters(params)).toEqual({ status: 'in_review', page: 3 });
  });

  it('falls back to defaults for missing/invalid values', () => {
    expect(parseFilters(new URLSearchParams(''))).toEqual({ status: '', page: 1 });
    expect(parseFilters(new URLSearchParams('status=bogus&page=0')).status).toBe('');
    expect(parseFilters(new URLSearchParams('page=-2')).page).toBe(1);
  });
});

describe('buildQueryString / buildApiQuery (deep-link vs API)', () => {
  it('omits defaults from the deep-link URL', () => {
    expect(buildQueryString({ status: '', page: 1 })).toBe('');
  });

  it('includes non-default filters in the deep-link URL', () => {
    const qs = buildQueryString({ status: 'pending', page: 2 });
    expect(qs).toContain('status=pending');
    expect(qs).toContain('page=2');
  });

  it('always sends page and page_size to the API, even at defaults', () => {
    const qs = buildApiQuery({ status: '', page: 1 });
    const params = new URLSearchParams(qs);
    expect(params.get('page')).toBe('1');
    expect(params.get('page_size')).toBe('20');
    expect(params.has('status')).toBe(false);
  });

  it('forwards the status filter to the API', () => {
    const params = new URLSearchParams(buildApiQuery({ status: 'resolved', page: 1 }));
    expect(params.get('status')).toBe('resolved');
  });
});

describe('totalPages', () => {
  it('is always at least 1', () => {
    expect(totalPages(0)).toBe(1);
    expect(totalPages(-5)).toBe(1);
  });

  it('rounds up to the next full page', () => {
    expect(totalPages(21, 20)).toBe(2);
    expect(totalPages(40, 20)).toBe(2);
    expect(totalPages(41, 20)).toBe(3);
  });
});

describe('formatDateTime', () => {
  it('renders a dash for null/invalid input', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });

  it('formats a valid ISO timestamp', () => {
    expect(formatDateTime('2026-07-09T12:30:00.000Z')).not.toBe('—');
  });
});

describe('playerLabel', () => {
  it('prefers the resolved name', () => {
    expect(playerLabel('11111111-1111-1111-1111-111111111111', 'Alice')).toBe('Alice');
  });

  it('falls back to a shortened id when no name is known', () => {
    expect(playerLabel('11111111-1111-1111-1111-111111111111', null)).toBe('11111111…');
  });

  it('falls back to the raw target string when there is no id either', () => {
    expect(playerLabel(null, null, 'RandomGuy123')).toBe('RandomGuy123');
  });

  it('falls back to an em dash when nothing is known', () => {
    expect(playerLabel(null, null, null)).toBe('—');
  });
});

describe('evidenceBadgeLabel', () => {
  it('is empty when there is no evidence', () => {
    expect(evidenceBadgeLabel([])).toBe('');
    expect(evidenceBadgeLabel(undefined)).toBe('');
  });

  it('shows a paperclip + count when evidence is attached', () => {
    expect(evidenceBadgeLabel([makeEvidence()])).toBe('📎 1');
    expect(evidenceBadgeLabel([makeEvidence(), makeEvidence({ id: 'e2' })])).toBe('📎 2');
  });
});

describe('evidence kind predicates', () => {
  it('classifies image/video/external_link kinds', () => {
    const image = makeEvidence({ kind: 'image' });
    const video = makeEvidence({ kind: 'video' });
    const link = makeEvidence({ kind: 'external_link' });

    expect(isImageEvidence(image)).toBe(true);
    expect(isVideoEvidence(image)).toBe(false);
    expect(isExternalLinkEvidence(image)).toBe(false);

    expect(isVideoEvidence(video)).toBe(true);
    expect(isImageEvidence(video)).toBe(false);

    expect(isExternalLinkEvidence(link)).toBe(true);
    expect(isVideoEvidence(link)).toBe(false);
  });
});

describe('evidenceLabel', () => {
  it('prefers the title', () => {
    expect(evidenceLabel(makeEvidence({ title: 'Аимбот на записи' }))).toBe('Аимбот на записи');
  });

  it('falls back to the external URL when there is no title', () => {
    expect(
      evidenceLabel(
        makeEvidence({ title: null, external_url: 'https://youtu.be/abc', kind: 'external_link' }),
      ),
    ).toBe('https://youtu.be/abc');
  });

  it('falls back to the original filename when there is no title or URL', () => {
    expect(evidenceLabel(makeEvidence({ title: null, external_url: null }))).toBe('screenshot.png');
  });
});
