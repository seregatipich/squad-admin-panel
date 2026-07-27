import { describe, expect, it } from 'vitest';
import {
  destinationLabel,
  isPublishable,
  type MediaPublication,
  PUBLICATION_DESTINATIONS,
  publicationErrorLabel,
  publicationsUrl,
  statusLabel,
} from './media-publications';

function publication(overrides: Partial<MediaPublication> = {}): MediaPublication {
  return {
    id: 'pub-1',
    media_id: 'media-1',
    destination: 'telegram',
    status: 'queued',
    external_id: null,
    external_url: null,
    error: null,
    attempts: 0,
    next_attempt_at: null,
    ...overrides,
  };
}

describe('PUBLICATION_DESTINATIONS', () => {
  it('offers exactly the two destinations the API accepts', () => {
    expect([...PUBLICATION_DESTINATIONS]).toEqual(['youtube', 'telegram']);
  });
});

describe('destinationLabel', () => {
  it('names each destination', () => {
    expect(destinationLabel('youtube')).toBe('YouTube');
    expect(destinationLabel('telegram')).toBe('Telegram');
  });
});

describe('publicationsUrl', () => {
  it('builds the per-media publications endpoint', () => {
    expect(publicationsUrl('abc')).toBe('/api/v1/media/abc/publications');
  });
});

describe('isPublishable', () => {
  it('allows stored video and image files', () => {
    expect(isPublishable('video')).toBe(true);
    expect(isPublishable('image')).toBe(true);
  });

  it('rejects an external link, which has no local file to upload', () => {
    expect(isPublishable('external_link')).toBe(false);
  });
});

describe('statusLabel', () => {
  it('labels a fresh queue entry', () => {
    expect(statusLabel(publication())).toBe('в очереди');
  });

  it('labels an upload in flight', () => {
    expect(statusLabel(publication({ status: 'uploading' }))).toBe('загружается');
  });

  it('labels a completed publication', () => {
    expect(statusLabel(publication({ status: 'published' }))).toBe('опубликовано');
  });

  it('labels a permanently failed publication', () => {
    expect(statusLabel(publication({ status: 'failed' }))).toBe('ошибка');
  });

  it('distinguishes a quota-blocked job from an ordinary retry', () => {
    const quota = publication({ status: 'queued', error: 'quota_exceeded', attempts: 2 });
    expect(statusLabel(quota)).toBe('ждёт квоту YouTube');
  });

  it('labels a scheduled retry once an attempt has been spent', () => {
    const retrying = publication({ status: 'queued', error: 'telegram_5xx', attempts: 1 });
    expect(statusLabel(retrying)).toBe('повтор запланирован');
  });

  it('labels a destination that has no credentials yet', () => {
    const deferred = publication({ status: 'queued', error: 'destination_not_configured' });
    expect(statusLabel(deferred)).toBe('нет настроек интеграции');
  });
});

describe('publicationErrorLabel', () => {
  it('translates the known machine codes', () => {
    expect(publicationErrorLabel('quota_exceeded')).toBe('Достигнута суточная квота YouTube.');
    expect(publicationErrorLabel('telegram_file_too_large')).toBe(
      'Файл больше 50 МБ — Telegram не принимает такие через бота.',
    );
    expect(publicationErrorLabel('destination_not_configured')).toBe(
      'Направление не настроено: заполните секреты в настройках.',
    );
  });

  it('passes an unknown code through unchanged rather than hiding it', () => {
    expect(publicationErrorLabel('youtube_initiate_rejected_400')).toBe(
      'youtube_initiate_rejected_400',
    );
  });

  it('returns null when there is no error', () => {
    expect(publicationErrorLabel(null)).toBeNull();
  });
});
