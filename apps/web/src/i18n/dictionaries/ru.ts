/**
 * Russian dictionary — the source of truth for the translation-key set.
 *
 * Keys are flat, dot-namespaced strings (`login.heading`, `nav.dashboard`,
 * `errors.rate_limited`). The English dictionary is typed against
 * `keyof typeof ru`, so any key added here must also be translated there or
 * the build fails. `{token}` placeholders are substituted by the translator.
 */
export const ru = {
  'app.title': 'Squad Admin Panel',
  'app.description': 'Опенсорсная self-hosted админ-панель для выделенных серверов Squad',

  'nav.brand': 'Squad Admin Panel',
  'nav.group.servers': 'Серверы',
  'nav.group.management': 'Управление',
  'nav.group.audit': 'Аудит',
  'nav.group.settings': 'Настройки',
  'nav.dashboard': 'Дашборд',
  'nav.serversArchive': 'Архив',
  'nav.players': 'Игроки',
  'nav.allPlayers': 'Все игроки',
  'nav.suspects': 'Метки',
  'nav.leaderboards': 'Лидерборды',
  'nav.bonusLeaderboard': 'Бонусы',
  'nav.statistics': 'Статистика',
  'nav.clans': 'Кланы',
  'nav.matches': 'Матчи',
  'nav.balancer': 'Балансировщик',
  'nav.events': 'События',
  'nav.combatLog': 'Боевой лог',
  'nav.votes': 'Голосования',
  'nav.chat': 'Чат',
  'nav.notes': 'Заметки',
  'nav.bannedNames': 'Забаненные ники',
  'nav.externalBans': 'Внешние баны',
  'nav.reports': 'Жалобы',
  'nav.appeals': 'Апелляции',
  'nav.issues': 'Тикеты',
  'nav.vips': 'VIP',
  'nav.groups': 'Группы',
  'nav.administration': 'Администрация',
  'nav.teamkills': 'Тимкиллы',
  'nav.audit': 'Журнал действий',
  'nav.logs': 'Логи',
  'nav.account': 'Аккаунт',
  'nav.messageTemplates': 'Шаблоны сообщений',
  'nav.markTypes': 'Типы меток',
  'nav.chatFlags': 'Флаги чата',
  'nav.altDetection': 'Альт-детект',
  'nav.seasons': 'Сезоны',
  'nav.alerts': 'Оповещения',
  'nav.automation': 'Автоматизация',
  'nav.seedNotifications': 'Уведомления о сидинге',
  'nav.whitelist': 'Whitelist',
  'nav.economy': 'Экономика',
  'nav.clanGuard': 'Защита клан-тегов',
  'nav.tokens': 'API-токены',
  'nav.backup': 'Бэкапы',
  'nav.banSources': 'Источники банов',
  'nav.discord': 'Discord',
  'nav.geoip': 'GeoIP (MaxMind)',
  'nav.mediaPublishing': 'Публикация медиа',
  'nav.logout': 'Выйти',

  'login.heading': 'Squad Admin Panel',
  'login.error.authFailed': 'Не удалось проверить вход через Steam. Попробуйте ещё раз.',
  'login.error.notAuthorized':
    'Steam ID {steamId} не имеет доступа к панели. Обратитесь к администратору.',
  'login.steamButton': 'Войти через Steam',

  'connection.unavailable': 'Панель временно недоступна.',
  'connection.retry': 'Повторить',
  'connection.dismiss': 'Скрыть',

  'localeSwitch.label': 'Язык',
  'localeSwitch.en': 'English',
  'localeSwitch.ru': 'Русский',

  'errors.invalid_period': 'Некорректный период.',
  'errors.rate_limited': 'Слишком много запросов. Попробуйте позже.',
  'errors.internal_error': 'Внутренняя ошибка сервера.',
  'errors.unknown': 'Произошла ошибка. Попробуйте ещё раз.',
} as const;

/** A valid translation key (every key present in the Russian dictionary). */
export type TranslationKey = keyof typeof ru;
