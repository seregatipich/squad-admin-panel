import {
  DISCORD_TEMPLATE_EVENT_TYPES,
  type DiscordTemplateEventType,
} from '@squad/shared-config/discord-template';

/** Event types a webhook or template can be bound to (single source: shared-config). */
export const DISCORD_EVENT_TYPES = DISCORD_TEMPLATE_EVENT_TYPES;

export type DiscordEventType = DiscordTemplateEventType;

const EVENT_LABELS: Record<DiscordEventType, string> = {
  server_crashed: 'Сервер упал',
  ban_issued: 'Выдан бан',
  unban: 'Снятие бана',
  kick: 'Кик',
  warn: 'Предупреждение',
  admin_login: 'Вход администратора',
  player_report: 'Жалоба на игрока',
  match_ended: 'Матч завершён',
  map_changed: 'Смена карты',
  marked_player_joined: 'Зашёл отмеченный игрок',
  drift_detected: 'Обнаружен дрейф конфигурации',
  server_monitoring: 'Мониторинг сервера',
  seed_needed: 'Нужны сидеры',
};

export function eventLabel(type: string): string {
  return (EVENT_LABELS as Record<string, string>)[type] ?? type;
}

const API_ERROR_LABELS: Record<string, string> = {
  unauthenticated: 'Сессия истекла, войдите заново',
  forbidden: 'Недостаточно прав',
  validation_failed: 'Проверьте введённые значения',
  webhook_not_found: 'Вебхук не найден — возможно, он уже удалён',
  template_not_found: 'Шаблон не найден',
  server_not_found: 'Сервер не найден',
  unknown_server_id: 'Неизвестный сервер',
  role_not_found: 'Роль не найдена',
  role_mapping_exists: 'Такое сопоставление уже существует',
  mapping_not_found: 'Сопоставление не найдено',
  discord_error: 'Discord отклонил запрос',
  unreachable: 'Discord недоступен',
};

/**
 * Russian operator-facing text for a failed Discord integration API call.
 * Known error codes are translated; anything else falls back to a generic
 * sentence, with the HTTP status kept as a secondary detail.
 *
 * @param status HTTP status of the failed response.
 * @param code `error` field of the response body, if any.
 */
export function describeApiError(status: number, code?: unknown): string {
  const label = typeof code === 'string' ? API_ERROR_LABELS[code] : undefined;
  return `${label ?? 'Запрос не выполнен'} (HTTP ${status})`;
}

export function looksLikeWebhookUrl(url: string): boolean {
  return /^https:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_.-]+$/i.test(
    url.trim(),
  );
}

export interface TestSendOutcome {
  kind: 'ok' | 'err';
  text: string;
}

/**
 * Turns a `POST /webhooks/:id/test` response into the Russian inline message
 * shown next to the "Тест" button. `ok` distinguishes a 2xx from any other
 * status; `body` is the parsed JSON error payload (or `{}` if unparseable).
 */
export function describeTestSendOutcome(
  ok: boolean,
  body: { error?: string; status?: number },
): TestSendOutcome {
  if (ok) return { kind: 'ok', text: 'Отправлено' };
  switch (body.error) {
    case 'discord_error':
      return { kind: 'err', text: `Discord вернул ${body.status ?? '?'}` };
    case 'unreachable':
      return { kind: 'err', text: 'Вебхук недоступен' };
    case 'webhook_not_found':
      return { kind: 'err', text: 'Вебхук не найден' };
    case 'webhook_url_unreadable':
      return {
        kind: 'err',
        text: 'URL вебхука не расшифровывается — удалите вебхук и добавьте заново',
      };
    default:
      return { kind: 'err', text: 'Не удалось отправить тестовое сообщение' };
  }
}
