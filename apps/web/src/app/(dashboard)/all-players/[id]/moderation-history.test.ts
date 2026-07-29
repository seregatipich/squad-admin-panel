import { describe, expect, it } from 'vitest';

import {
  authorLabel,
  canDetachEvidence,
  detachEvidenceUrl,
  evidenceLabel,
  formatModerationDate,
  mediaStreamUrl,
  moderationActionBadgeClass,
  moderationActionLabel,
} from './moderation-history';

describe('moderationActionLabel', () => {
  it('translates the panel-issued action types', () => {
    expect(moderationActionLabel('warn')).toBe('Предупреждение');
    expect(moderationActionLabel('kick')).toBe('Кик');
    expect(moderationActionLabel('ban')).toBe('Бан');
    expect(moderationActionLabel('unban')).toBe('Разбан');
  });

  it('translates the worker-issued action types', () => {
    expect(moderationActionLabel('name_kick')).toBe('Кик за ник');
    expect(moderationActionLabel('external_ban_kick')).toBe('Кик по внешнему бану');
    expect(moderationActionLabel('external_ban.local_ban')).toBe('Локальный бан по внешнему');
    expect(moderationActionLabel('clan_tag_protection')).toBe('Защита клан-тега');
  });

  it('falls back to the raw action type for an unknown value', () => {
    expect(moderationActionLabel('teleport_abuse')).toBe('teleport_abuse');
  });
});

describe('moderationActionBadgeClass', () => {
  it('gives bans and kicks distinct badge classes', () => {
    expect(moderationActionBadgeClass('ban')).not.toBe(moderationActionBadgeClass('kick'));
  });

  it('falls back to the neutral badge class for an unknown action type', () => {
    expect(moderationActionBadgeClass('teleport_abuse')).toBe(
      moderationActionBadgeClass('__definitely_unknown__'),
    );
  });
});

describe('formatModerationDate', () => {
  it('renders an ISO timestamp in ru-RU', () => {
    expect(formatModerationDate('2026-07-27T10:00:00.000Z')).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it('returns an em dash for null', () => {
    expect(formatModerationDate(null)).toBe('—');
  });

  it('returns an em dash for an unparseable value', () => {
    expect(formatModerationDate('not-a-date')).toBe('—');
  });
});

describe('authorLabel', () => {
  it('uses the player name when the author is a panel user', () => {
    expect(authorLabel({ kind: 'player', id: 'p1', name: 'Модератор Вася' })).toBe(
      'Модератор Вася',
    );
  });

  it('falls back to a generic label for a nameless player author', () => {
    expect(authorLabel({ kind: 'player', id: 'p1', name: null })).toBe('Неизвестный модератор');
  });

  it('uses the system label for a worker-issued action', () => {
    expect(authorLabel({ kind: 'system', label: 'banname-worker' })).toBe('banname-worker');
  });

  it('falls back to a generic label for a system author with no label', () => {
    expect(authorLabel({ kind: 'system', label: null })).toBe('Система');
  });
});

describe('evidenceLabel', () => {
  const base = {
    id: 'media-1',
    kind: 'video' as const,
    external_url: null,
    original_filename: 'clip.mp4',
    mime_type: 'video/mp4',
    size_bytes: 10,
    title: null as string | null,
    linked_by_player_id: null as string | null,
    linked_at: '2026-07-27T10:00:00.000Z',
  };

  it('prefers the title', () => {
    expect(evidenceLabel({ ...base, title: 'Аимбот' })).toBe('Аимбот');
  });

  it('falls back to the original filename', () => {
    expect(evidenceLabel(base)).toBe('clip.mp4');
  });
});

describe('mediaStreamUrl', () => {
  it('points at the Range-streaming media route', () => {
    expect(mediaStreamUrl('media-1')).toBe('/api/v1/media/media-1/stream');
  });
});

describe('detachEvidenceUrl', () => {
  it('addresses the media_links row by media id plus the moderation-action entity', () => {
    expect(detachEvidenceUrl('media-1', 'action-1')).toBe(
      '/api/v1/media/media-1/links?entity_type=moderation_action&entity_id=action-1',
    );
  });
});

describe('canDetachEvidence', () => {
  it('allows detaching your own link', () => {
    expect(canDetachEvidence('player-1', 'player-1')).toBe(true);
  });

  it('refuses someone else s link', () => {
    expect(canDetachEvidence('player-2', 'player-1')).toBe(false);
  });

  it('refuses a link whose author is unknown', () => {
    expect(canDetachEvidence(null, 'player-1')).toBe(false);
  });

  it('refuses when the viewer is not identified', () => {
    expect(canDetachEvidence('player-1', null)).toBe(false);
  });
});
