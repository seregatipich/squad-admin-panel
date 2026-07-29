/**
 * Single source of truth for the panel's page navigation tree.
 *
 * Shared by {@link SidebarNav} (renders the grouped sidebar) and
 * {@link CommandPalette} (flattens it into a searchable "Pages" section),
 * so a new page only needs to be added here once.
 */

import type { TranslationKey } from '@/i18n/translate';

/** Translation keys used for navigation labels (the `nav.*` namespace). */
export type NavLabelKey = Extract<TranslationKey, `nav.${string}`>;

/**
 * A single navigable page, or a collapsible group header when `children` is
 * set. `permission`, when set, gates visibility.
 *
 * `label` is the Russian source label (also the CommandPalette search/display
 * text). `labelKey`, when set, is the i18n key the localized sidebar renders
 * through the active-locale translator; it defaults to matching `label` in the
 * Russian dictionary (guarded by a test in `nav.test.ts`).
 */
export interface NavItem {
  /** Omitted for a group header rendered via `children` — it has no page of its own. */
  href?: string;
  label: string;
  labelKey?: NavLabelKey;
  permission?: string;
  /** When set, renders a live count badge of reports awaiting moderation. */
  showsPendingReports?: boolean;
  /** When set, the item is visible only while the economy module is enabled. */
  requiresEconomy?: boolean;
  /** When set, the sidebar renders this item as a collapsible group of sub-items instead of a link. */
  children?: NavItem[];
}

/** A labeled group of {@link NavItem}s as rendered in the sidebar. */
export interface NavGroup {
  label?: string;
  labelKey?: NavLabelKey;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    items: [{ href: '/dashboard', label: 'Дашборд', labelKey: 'nav.dashboard' }],
  },
  {
    label: 'Серверы',
    labelKey: 'nav.group.servers',
    items: [
      {
        href: '/servers/archive',
        label: 'Архив',
        labelKey: 'nav.serversArchive',
        permission: 'server:view',
      },
    ],
  },
  {
    label: 'Управление',
    labelKey: 'nav.group.management',
    items: [
      {
        label: 'Игроки',
        labelKey: 'nav.players',
        children: [
          { href: '/all-players', label: 'Все игроки', labelKey: 'nav.allPlayers' },
          { href: '/suspects', label: 'Метки', labelKey: 'nav.suspects' },
          { href: '/banned-names', label: 'Забаненные ники', labelKey: 'nav.bannedNames' },
          { href: '/external-bans', label: 'Внешние баны', labelKey: 'nav.externalBans' },
          { href: '/vips', label: 'VIP', labelKey: 'nav.vips', permission: 'user:view' },
          {
            href: '/users',
            label: 'Администрация',
            labelKey: 'nav.administration',
            permission: 'user:view',
          },
        ],
      },
      { href: '/leaderboards', label: 'Лидерборды', labelKey: 'nav.leaderboards' },
      {
        href: '/leaderboards/bonuses',
        label: 'Бонусы',
        labelKey: 'nav.bonusLeaderboard',
        requiresEconomy: true,
      },
      { href: '/statistics', label: 'Статистика', labelKey: 'nav.statistics' },
      { href: '/clans', label: 'Кланы', labelKey: 'nav.clans' },
      { href: '/matches', label: 'Матчи', labelKey: 'nav.matches' },
      {
        href: '/balancer',
        label: 'Балансировщик',
        labelKey: 'nav.balancer',
        permission: 'balancer:view',
      },
      { href: '/events', label: 'События', labelKey: 'nav.events' },
      { href: '/combat-log', label: 'Боевой лог', labelKey: 'nav.combatLog' },
      { href: '/votes', label: 'Голосования', labelKey: 'nav.votes' },
      { href: '/chat', label: 'Чат', labelKey: 'nav.chat' },
      { href: '/notes', label: 'Заметки', labelKey: 'nav.notes' },
      {
        href: '/reports',
        label: 'Жалобы',
        labelKey: 'nav.reports',
        showsPendingReports: true,
      },
      {
        href: '/appeals',
        label: 'Апелляции',
        labelKey: 'nav.appeals',
        permission: 'mod:unban',
      },
      { href: '/issues', label: 'Тикеты', labelKey: 'nav.issues' },
      {
        href: '/settings/groups',
        label: 'Группы',
        labelKey: 'nav.groups',
        permission: 'role:view',
      },
    ],
  },
  {
    label: 'Аудит',
    labelKey: 'nav.group.audit',
    items: [
      { href: '/moderation/teamkills', label: 'Тимкиллы', labelKey: 'nav.teamkills' },
      { href: '/audit', label: 'Журнал действий', labelKey: 'nav.audit' },
      { href: '/logs', label: 'Логи', labelKey: 'nav.logs', permission: 'host:view' },
    ],
  },
  {
    label: 'Настройки',
    labelKey: 'nav.group.settings',
    items: [
      { href: '/settings/account', label: 'Аккаунт', labelKey: 'nav.account' },
      {
        href: '/settings/message-templates',
        label: 'Шаблоны сообщений',
        labelKey: 'nav.messageTemplates',
        permission: 'role:edit',
      },
      {
        href: '/settings/mark-types',
        label: 'Типы меток',
        labelKey: 'nav.markTypes',
        permission: 'role:edit',
      },
      {
        href: '/settings/chat-flags',
        label: 'Флаги чата',
        labelKey: 'nav.chatFlags',
        permission: 'role:edit',
      },
      {
        href: '/settings/seasons',
        label: 'Сезоны',
        labelKey: 'nav.seasons',
        permission: 'role:edit',
      },
      {
        href: '/settings/alt-detection',
        label: 'Альт-детект',
        labelKey: 'nav.altDetection',
        permission: 'player:view_ips',
      },
      { href: '/settings/alerts', label: 'Оповещения', labelKey: 'nav.alerts' },
      { href: '/settings/automation', label: 'Автоматизация', labelKey: 'nav.automation' },
      {
        href: '/settings/seed-notifications',
        label: 'Уведомления о сидинге',
        labelKey: 'nav.seedNotifications',
      },
      {
        href: '/settings/whitelist',
        label: 'Whitelist',
        labelKey: 'nav.whitelist',
        permission: 'whitelist:view',
      },
      { href: '/settings/economy', label: 'Экономика', labelKey: 'nav.economy' },
      { href: '/settings/clan-guard', label: 'Защита клан-тегов', labelKey: 'nav.clanGuard' },
      { href: '/settings/tokens', label: 'API-токены', labelKey: 'nav.tokens' },
      {
        href: '/settings/backup',
        label: 'Бэкапы',
        labelKey: 'nav.backup',
        permission: 'host:manage',
      },
      { href: '/settings/ban-sources', label: 'Источники банов', labelKey: 'nav.banSources' },
      {
        href: '/settings/integrations/discord',
        label: 'Discord',
        labelKey: 'nav.discord',
        permission: 'integration:manage',
      },
      {
        href: '/settings/integrations/geoip',
        label: 'GeoIP (MaxMind)',
        labelKey: 'nav.geoip',
        permission: 'integration:manage',
      },
      {
        href: '/settings/integrations/media',
        label: 'Публикация медиа',
        labelKey: 'nav.mediaPublishing',
        permission: 'integration:manage',
      },
    ],
  },
];

/**
 * Flattens grouped nav items into a single list of navigable pages, dropping
 * group labels and expanding `children` groups into their sub-items (the
 * group header itself has no page of its own, so it is not included).
 */
export function flattenNavItems(groups: NavGroup[]): NavItem[] {
  return groups.flatMap((group) =>
    group.items.flatMap((item) => (item.children ? item.children : [item])),
  );
}
