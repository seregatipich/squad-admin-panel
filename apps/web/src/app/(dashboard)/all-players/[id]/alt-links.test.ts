import { describe, expect, it } from 'vitest';
import {
  type AltCandidate,
  buildLinkPayload,
  formatRejectedMark,
  LINK_TYPE_LABELS_RU,
  PLAYER_LINK_TYPES,
  splitCandidates,
} from './alt-links';

function makeCandidate(overrides: Partial<AltCandidate> = {}): AltCandidate {
  return {
    player_id: 'candidate-1',
    current_name: 'Ghost',
    steam_id64: '76561198000000001',
    shared_ip_count: 2,
    ignored_shared_ip_count: 0,
    min_time_delta_seconds: 120,
    score: 75,
    confidence: 'high',
    has_active_ban: false,
    has_permanent_ban: false,
    signals: {
      shared_ips: { value: 2, weight: 50 },
      shared_names: { value: ['ghost'], weight: 25 },
      young_account: { value: false, weight: 15 },
      steamid_proximity: { value: false, weight: 10 },
    },
    link: null,
    ...overrides,
  };
}

describe('LINK_TYPE_LABELS_RU', () => {
  it('covers all four link types', () => {
    for (const type of PLAYER_LINK_TYPES) {
      expect(LINK_TYPE_LABELS_RU[type]).toBeTruthy();
    }
    expect(Object.keys(LINK_TYPE_LABELS_RU)).toHaveLength(4);
  });
});

describe('splitCandidates', () => {
  it('separates rejected candidates from unresolved/confirmed ones', () => {
    const unresolvedCandidate = makeCandidate({ player_id: 'a' });
    const confirmedCandidate = makeCandidate({
      player_id: 'b',
      link: {
        id: 'link-1',
        link_type: 'alt',
        status: 'confirmed',
        note: null,
        decided_by_name: 'Admin',
        decided_at: '2026-07-01T00:00:00.000Z',
      },
    });
    const rejectedCandidate = makeCandidate({
      player_id: 'c',
      link: {
        id: 'link-2',
        link_type: 'unrelated',
        status: 'rejected',
        note: null,
        decided_by_name: 'Admin',
        decided_at: '2026-07-02T00:00:00.000Z',
      },
    });

    const { unresolved, rejected } = splitCandidates([
      unresolvedCandidate,
      confirmedCandidate,
      rejectedCandidate,
    ]);

    expect(unresolved.map((c) => c.player_id)).toEqual(['a', 'b']);
    expect(rejected.map((c) => c.player_id)).toEqual(['c']);
  });

  it('returns empty arrays for an empty input', () => {
    expect(splitCandidates([])).toEqual({ unresolved: [], rejected: [] });
  });
});

describe('formatRejectedMark', () => {
  it('renders the admin name and formatted date', () => {
    const mark = formatRejectedMark({
      id: 'link-1',
      link_type: 'unrelated',
      status: 'rejected',
      note: null,
      decided_by_name: 'Owner',
      decided_at: '2026-07-09T10:00:00.000Z',
    });
    expect(mark).toBe('Отклонено админом Owner 09.07.2026');
  });

  it('falls back to a generic label when decided_by_name is null', () => {
    const mark = formatRejectedMark({
      id: 'link-1',
      link_type: 'unrelated',
      status: 'rejected',
      note: null,
      decided_by_name: null,
      decided_at: '2026-07-09T10:00:00.000Z',
    });
    expect(mark).toContain('Отклонено админом');
    expect(mark).toContain('09.07.2026');
  });
});

describe('buildLinkPayload', () => {
  it('embeds the candidate score/confidence/shared_ip_count snapshot', () => {
    const candidate = makeCandidate();
    const payload = buildLinkPayload('other-1', 'alt', 'confirmed', '', candidate);

    expect(payload).toMatchObject({
      other_player_id: 'other-1',
      link_type: 'alt',
      status: 'confirmed',
    });
    expect(payload.note).toBeUndefined();
    expect(payload.evidence_snapshot).toMatchObject({
      score: 75,
      confidence: 'high',
      shared_ip_count: 2,
      shared_names: ['ghost'],
    });
  });

  it('trims and includes a non-empty note', () => {
    const payload = buildLinkPayload(
      'other-1',
      'family_share',
      'rejected',
      '  test note  ',
      makeCandidate(),
    );
    expect(payload.note).toBe('test note');
  });
});
