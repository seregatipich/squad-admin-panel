export const DISCORD_EVENT_TYPES = [
  'server_crashed',
  'ban_issued',
  'unban',
  'kick',
  'warn',
  'admin_login',
  'player_report',
  'match_ended',
  'map_changed',
  'marked_player_joined',
  'drift_detected',
  'server_monitoring',
] as const;

export type DiscordEventType = (typeof DISCORD_EVENT_TYPES)[number];

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
};

export function eventLabel(type: string): string {
  return (EVENT_LABELS as Record<string, string>)[type] ?? type;
}

export function looksLikeWebhookUrl(url: string): boolean {
  return /^https?:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_.-]+$/i.test(
    url.trim(),
  );
}
