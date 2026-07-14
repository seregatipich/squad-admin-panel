export const REPORT_BODY_MAX = 2000;
export const REPORT_EVIDENCE_MAX = 10;

export interface ReportSubmitPayload {
  server_id: string;
  target_player_id: string;
  body: string;
  evidence_media_ids: string[];
}

/**
 * Builds the `POST /api/v1/reports` request body: trims the report text and
 * de-duplicates the attached evidence ids (submission order is preserved).
 */
export function buildReportPayload(
  serverId: string,
  targetPlayerId: string,
  body: string,
  mediaIds: string[],
): ReportSubmitPayload {
  return {
    server_id: serverId,
    target_player_id: targetPlayerId,
    body: body.trim(),
    evidence_media_ids: Array.from(new Set(mediaIds)),
  };
}

/** Validates a manually-entered evidence link: must be an absolute http(s) URL. */
export function validateEvidenceUrl(url: string): { ok: true } | { ok: false; error: string } {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: 'Ссылка не может быть пустой' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Некорректная ссылка' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Ссылка должна начинаться с http:// или https://' };
  }
  return { ok: true };
}

/** Maps a `POST /api/v1/media` (or `/media/link`) failure response to a Russian message. */
export function mapUploadError(status: number, errorCode?: string): string {
  switch (status) {
    case 413:
      return 'Файл слишком большой';
    case 415:
      return 'Неподдерживаемый формат';
    case 400:
      if (errorCode === 'magic_byte_mismatch') return 'Содержимое файла не соответствует формату';
      return 'Некорректный файл';
    case 401:
      return 'Сессия истекла, перезайдите в панель';
    case 403:
      return 'Нет доступа для загрузки вложений';
    default:
      return `Ошибка загрузки (HTTP ${status})`;
  }
}
