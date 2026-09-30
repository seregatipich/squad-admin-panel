import { describe, expect, it } from 'vitest';

import {
  authorLabel,
  canDetachEvidence,
  detachEvidenceUrl,
  evidenceLabel,
  MODERATION_HISTORY_PAGE_SIZE,
  mediaStreamUrl,
  moderationActionsUrl,
} from './moderation-history';

describe('moderationActionsUrl', () => {
  it('asks for one row more than a page so the card knows whether more exist (#441)', () => {
    expect(moderationActionsUrl('player-1', null)).toBe(
      `/api/v1/players/player-1/moderation-actions?limit=${MODERATION_HISTORY_PAGE_SIZE + 1}`,
    );
  });

  it('passes the cursor of the last row shown', () => {
    expect(moderationActionsUrl('player-1', 'action-9')).toBe(
      `/api/v1/players/player-1/moderation-actions?limit=${MODERATION_HISTORY_PAGE_SIZE + 1}&cursor=action-9`,
    );
  });

  it('encodes a route segment so it cannot climb out of the player path (#472)', () => {
    expect(moderationActionsUrl('../../admin?', null)).toBe(
      `/api/v1/players/..%2F..%2Fadmin%3F/moderation-actions?limit=${MODERATION_HISTORY_PAGE_SIZE + 1}`,
    );
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

  it('encodes the media id path segment (#472)', () => {
    expect(mediaStreamUrl('../x')).toBe('/api/v1/media/..%2Fx/stream');
  });
});

describe('detachEvidenceUrl', () => {
  it('addresses the media_links row by media id plus the moderation-action entity', () => {
    expect(detachEvidenceUrl('media-1', 'action-1')).toBe(
      '/api/v1/media/media-1/links?entity_type=moderation_action&entity_id=action-1',
    );
  });

  it('encodes both ids so neither can rewrite the path or the query (#472)', () => {
    expect(detachEvidenceUrl('../m', 'a&entity_type=player')).toBe(
      '/api/v1/media/..%2Fm/links?entity_type=moderation_action&entity_id=a%26entity_type%3Dplayer',
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
