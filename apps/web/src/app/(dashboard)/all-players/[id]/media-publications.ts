/**
 * Pure helpers for the media-publication UI (VIDEO-4, #160).
 *
 * Kept out of the component so the branch-heavy label logic carries its own
 * unit tests, per this app's coverage split.
 */

export type MediaPublicationDestination = 'youtube' | 'telegram';
export type MediaPublicationStatus = 'queued' | 'uploading' | 'published' | 'failed';

export interface MediaPublication {
  id: string;
  media_id: string;
  destination: MediaPublicationDestination;
  status: MediaPublicationStatus;
  external_id: string | null;
  external_url: string | null;
  error: string | null;
  attempts: number;
  next_attempt_at: string | null;
}

export const PUBLICATION_DESTINATIONS = ['youtube', 'telegram'] as const;

const DESTINATION_LABELS: Record<MediaPublicationDestination, string> = {
  youtube: 'YouTube',
  telegram: 'Telegram',
};

export function destinationLabel(destination: MediaPublicationDestination): string {
  return DESTINATION_LABELS[destination];
}

export function publicationsUrl(mediaId: string): string {
  return `/api/v1/media/${mediaId}/publications`;
}

/** Only a media row backed by a local file can be uploaded to a third party. */
export function isPublishable(kind: 'video' | 'image' | 'external_link'): boolean {
  return kind !== 'external_link';
}

/**
 * Human status for one publication.
 *
 * `queued` is deliberately split three ways in the UI: the API keeps a
 * quota-blocked job and a backing-off job in the same state as a brand-new
 * one, and an operator staring at "в очереди" for six hours has no way to tell
 * which of the three is happening.
 */
export function statusLabel(publication: MediaPublication): string {
  switch (publication.status) {
    case 'uploading':
      return 'загружается';
    case 'published':
      return 'опубликовано';
    case 'failed':
      return 'ошибка';
    default: {
      if (publication.error === 'quota_exceeded') return 'ждёт квоту YouTube';
      if (publication.error === 'destination_not_configured') return 'нет настроек интеграции';
      if (publication.attempts > 0) return 'повтор запланирован';
      return 'в очереди';
    }
  }
}

const ERROR_LABELS: Record<string, string> = {
  quota_exceeded: 'Достигнута суточная квота YouTube.',
  telegram_file_too_large: 'Файл больше 50 МБ — Telegram не принимает такие через бота.',
  destination_not_configured: 'Направление не настроено: заполните секреты в настройках.',
  no_local_file: 'У записи нет локального файла для выгрузки.',
  youtube_unsupported_kind: 'YouTube принимает только видео.',
  youtube_auth_failed: 'YouTube отклонил учётные данные — обновите refresh-токен.',
  telegram_rate_limited: 'Telegram временно ограничил частоту запросов.',
};

/**
 * Translates a machine error code, passing an unrecognised one through
 * verbatim — hiding it would leave an operator with a failed publication and
 * no clue why.
 */
export function publicationErrorLabel(error: string | null): string | null {
  if (!error) return null;
  return ERROR_LABELS[error] ?? error;
}
