import { describe, expect, it } from 'vitest';
import type { ReportEvidenceItem, ReportListItem } from '@/lib/live-bus';
import {
  actionTypeBadge,
  buildApiQuery,
  buildQueryString,
  evidenceBadgeLabel,
  evidenceLabel,
  formatDateTime,
  groupPendingByTarget,
  isExternalLinkEvidence,
  isImageEvidence,
  isRecidivist,
  isValidBanLength,
  isVideoEvidence,
  parseFilters,
  playerLabel,
  RECIDIVIST_MIN_COUNT_90D,
  REPORTER_SPAM_LABEL,
  REPORTER_TRUSTED_LABEL,
  recidivistBadgeLabel,
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

function reportFixture(overrides: Partial<ReportListItem> = {}): ReportListItem {
  return {
    id: 'report-1',
    server_id: 'server-1',
    server_name: 'Server 1',
    server_slug: 'server-1',
    reporter_player_id: 'reporter-1',
    reporter_name: 'Reporter',
    target_player_id: 'target-1',
    target_name: 'Target',
    target_raw: null,
    body: 'Cheating',
    source: 'ingame',
    status: 'pending',
    handler_player_id: null,
    handler_name: null,
    resolution_note: null,
    created_at: '2026-07-09T12:00:00.000Z',
    claimed_at: null,
    resolved_at: null,
    evidence: [],
    evidence_count: 0,
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

describe('isValidBanLength', () => {
  it('accepts a bare number of days and permanent (0)', () => {
    expect(isValidBanLength('0')).toBe(true);
    expect(isValidBanLength('7')).toBe(true);
  });

  it('accepts a number with a duration unit suffix', () => {
    expect(isValidBanLength('3d')).toBe(true);
    expect(isValidBanLength('12h')).toBe(true);
    expect(isValidBanLength('2w')).toBe(true);
  });

  it('rejects empty, non-numeric, or malformed values', () => {
    expect(isValidBanLength('')).toBe(false);
    expect(isValidBanLength('x')).toBe(false);
    expect(isValidBanLength('1 d')).toBe(false);
    expect(isValidBanLength('-1')).toBe(false);
  });
});

describe('actionTypeBadge', () => {
  it('maps known action types to Russian labels', () => {
    expect(actionTypeBadge('warn')).toBe('Предупреждение');
    expect(actionTypeBadge('kick')).toBe('Кик');
    expect(actionTypeBadge('ban')).toBe('Бан');
  });

  it('falls back to the raw action type for unknown values', () => {
    expect(actionTypeBadge('name_kick')).toBe('name_kick');
  });
});

describe('groupPendingByTarget', () => {
  it('groups reports sharing a resolved target_player_id', () => {
    const items = [
      reportFixture({ id: 'r1', target_player_id: 'target-1' }),
      reportFixture({ id: 'r2', target_player_id: 'target-1' }),
      reportFixture({ id: 'r3', target_player_id: 'target-2' }),
    ];
    const { grouped, ungrouped } = groupPendingByTarget(items);
    expect(ungrouped).toHaveLength(0);
    expect(grouped).toHaveLength(2);
    expect(
      grouped.find((g) => g.target_player_id === 'target-1')?.reports.map((r) => r.id),
    ).toEqual(['r1', 'r2']);
    expect(
      grouped.find((g) => g.target_player_id === 'target-2')?.reports.map((r) => r.id),
    ).toEqual(['r3']);
  });

  it('leaves reports with no resolved target ungrouped', () => {
    const items = [
      reportFixture({ id: 'r1', target_player_id: null, target_raw: 'UnknownGuy' }),
      reportFixture({ id: 'r2', target_player_id: 'target-1' }),
    ];
    const { grouped, ungrouped } = groupPendingByTarget(items);
    expect(ungrouped.map((r) => r.id)).toEqual(['r1']);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.target_player_id).toBe('target-1');
  });
});

describe('isRecidivist', () => {
  it('is false below the threshold and true at/above it', () => {
    expect(isRecidivist(RECIDIVIST_MIN_COUNT_90D - 1)).toBe(false);
    expect(isRecidivist(RECIDIVIST_MIN_COUNT_90D)).toBe(true);
    expect(isRecidivist(0)).toBe(false);
  });
});

describe('recidivistBadgeLabel', () => {
  it('applies correct Russian pluralization', () => {
    expect(recidivistBadgeLabel(1)).toBe('1 жалоба за 90 дн');
    expect(recidivistBadgeLabel(3)).toBe('3 жалобы за 90 дн');
    expect(recidivistBadgeLabel(5)).toBe('5 жалоб за 90 дн');
    expect(recidivistBadgeLabel(11)).toBe('11 жалоб за 90 дн');
  });
});

describe('reporter trust badge constants', () => {
  it('exposes the trusted/spam Russian labels', () => {
    expect(REPORTER_TRUSTED_LABEL).toBe('Доверенный');
    expect(REPORTER_SPAM_LABEL).toBe('Спам');
  });
});
