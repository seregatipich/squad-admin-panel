/**
 * Single source of truth for the panel's page navigation tree.
 *
 * Shared by {@link SidebarNav} (renders the grouped sidebar) and
 * {@link CommandPalette} (flattens it into a searchable "Pages" section),
 * so a new page only needs to be added here once.
 */

/** A single navigable page. `permission`, when set, gates visibility. */
export interface NavItem {
  href: string;
  label: string;
  permission?: string;
  /** When set, renders a live count badge of reports awaiting moderation. */
  showsPendingReports?: boolean;
}

/** A labeled group of {@link NavItem}s as rendered in the sidebar. */
export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ href: '/dashboard', label: 'Дашборд' }],
  },
  {
    label: 'Серверы',
    items: [{ href: '/servers/archive', label: 'Архив', permission: 'server:view' }],
  },
  {
    label: 'Управление',
    items: [
      { href: '/players', label: 'Игроки' },
      { href: '/suspects', label: 'Метки' },
      { href: '/leaderboards', label: 'Лидерборды' },
      { href: '/clans', label: 'Кланы' },
      { href: '/matches', label: 'Матчи' },
      { href: '/events', label: 'События' },
      { href: '/combat-log', label: 'Боевой лог' },
      { href: '/votes', label: 'Голосования' },
      { href: '/chat', label: 'Чат' },
      { href: '/notes', label: 'Заметки' },
      { href: '/banned-names', label: 'Забаненные ники' },
      { href: '/reports', label: 'Жалобы', showsPendingReports: true },
      { href: '/issues', label: 'Тикеты' },
      { href: '/vips', label: 'VIP', permission: 'user:view' },
      { href: '/settings/groups', label: 'Группы', permission: 'role:view' },
      { href: '/users', label: 'Пользователи', permission: 'user:view' },
    ],
  },
  {
    label: 'Аудит',
    items: [
      { href: '/moderation/teamkills', label: 'Тимкиллы' },
      { href: '/audit', label: 'Журнал действий' },
      { href: '/logs', label: 'Логи', permission: 'host:view' },
    ],
  },
  {
    label: 'Настройки',
    items: [
      { href: '/settings/account', label: 'Аккаунт' },
      { href: '/settings/message-templates', label: 'Шаблоны сообщений', permission: 'role:edit' },
      { href: '/settings/mark-types', label: 'Типы меток', permission: 'role:edit' },
      { href: '/settings/chat-flags', label: 'Флаги чата', permission: 'role:edit' },
      { href: '/settings/alerts', label: 'Оповещения' },
      { href: '/settings/whitelist', label: 'Whitelist', permission: 'whitelist:view' },
      { href: '/settings/economy', label: 'Экономика' },
      { href: '/settings/clan-guard', label: 'Защита клан-тегов' },
      { href: '/settings/tokens', label: 'API-токены' },
      { href: '/settings/ban-sources', label: 'Источники банов' },
      {
        href: '/settings/integrations/discord',
        label: 'Discord',
        permission: 'integration:manage',
      },
      {
        href: '/settings/integrations/geoip',
        label: 'GeoIP (MaxMind)',
        permission: 'integration:manage',
      },
    ],
  },
];

/** Flattens grouped nav items into a single list, dropping group labels. */
export function flattenNavItems(groups: NavGroup[]): NavItem[] {
  return groups.flatMap((group) => group.items);
}
