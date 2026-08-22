/**
 * Single source of truth for the panel's page navigation tree.
 *
 * Shared by {@link TopNav} (renders the top bar and its dropdowns) and
 * {@link CommandPalette} (flattens it into a searchable "Pages" section), so a
 * new page only needs to be added here once.
 *
 * The tree is read as a top bar: every {@link NavGroup} is one bar entry. A
 * group with no `label` contributes its items as direct links in the bar; a
 * labeled group becomes a dropdown, and one whose items carry `children`
 * becomes a mega-menu with a column per child group.
 */

import type { TranslationKey } from '@/i18n/translate';

/** Translation keys used for navigation labels (the `nav.*` namespace). */
export type NavLabelKey = Extract<TranslationKey, `nav.${string}`>;

/**
 * A single navigable page, or a menu column header when `children` is set.
 * `permission`, when set, gates visibility.
 *
 * `label` is the Russian source label (also the CommandPalette search/display
 * text). `labelKey`, when set, is the i18n key the localized bar renders
 * through the active-locale translator; it defaults to matching `label` in the
 * Russian dictionary (guarded by a test in `nav.test.ts`).
 */
export interface NavItem {
  /** Omitted for a column header rendered via `children` — it has no page of its own. */
  href?: string;
  label: string;
  labelKey?: NavLabelKey;
  permission?: string;
  /** Short gloss rendered under the label inside a dropdown. */
  hint?: string;
  /** i18n key for {@link hint}. */
  hintKey?: NavLabelKey;
  /** When set, renders a live count badge of reports awaiting moderation. */
  showsPendingReports?: boolean;
  /** When set, the item is visible only while the economy module is enabled. */
  requiresEconomy?: boolean;
  /** When set, the item is a menu column of sub-items rather than a link. */
  children?: NavItem[];
}

/** One entry in the top bar: a direct link set (no `label`) or a dropdown. */
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
        href: '/servers',
        label: 'Все серверы',
        labelKey: 'nav.servers',
        hint: 'список и состояние',
        hintKey: 'nav.hint.servers',
        permission: 'server:view',
      },
      {
        href: '/servers/new',
        label: 'Создать сервер',
        labelKey: 'nav.serversNew',
        hint: 'порты, слоты, лимиты',
        hintKey: 'nav.hint.serversNew',
        permission: 'server:install',
      },
      {
        href: '/servers/archive',
        label: 'Архив',
        labelKey: 'nav.serversArchive',
        hint: 'удалённые серверы',
        hintKey: 'nav.hint.serversArchive',
        permission: 'server:view',
      },
    ],
  },
  {
    label: 'Игроки',
    labelKey: 'nav.players',
    items: [
      {
        href: '/all-players',
        label: 'Все игроки',
        labelKey: 'nav.allPlayers',
        hint: 'поиск по нику и SteamID',
        hintKey: 'nav.hint.allPlayers',
      },
      {
        href: '/suspects',
        label: 'Метки',
        labelKey: 'nav.suspects',
        hint: 'наблюдение и подозрения',
        hintKey: 'nav.hint.suspects',
      },
      {
        href: '/banned-names',
        label: 'Забаненные ники',
        labelKey: 'nav.bannedNames',
        hint: 'маски запрещённых имён',
        hintKey: 'nav.hint.bannedNames',
      },
      {
        href: '/external-bans',
        label: 'Внешние баны',
        labelKey: 'nav.externalBans',
        hint: 'импорт из чужих источников',
        hintKey: 'nav.hint.externalBans',
      },
      {
        href: '/vips',
        label: 'VIP',
        labelKey: 'nav.vips',
        hint: 'привилегии и сроки',
        hintKey: 'nav.hint.vips',
        permission: 'user:view',
      },
      {
        href: '/users',
        label: 'Администрация',
        labelKey: 'nav.administration',
        hint: 'учётные записи панели',
        hintKey: 'nav.hint.administration',
        permission: 'user:view',
      },
    ],
  },
  {
    label: 'Инструменты',
    labelKey: 'nav.tools',
    items: [
      {
        label: 'Статистика',
        labelKey: 'nav.statistics',
        children: [
          {
            href: '/statistics',
            label: 'Статистика',
            labelKey: 'nav.statistics',
            hint: 'сводка по серверам',
            hintKey: 'nav.hint.statistics',
          },
          {
            href: '/leaderboards',
            label: 'Лидерборды',
            labelKey: 'nav.leaderboards',
            hint: 'топ игроков',
            hintKey: 'nav.hint.leaderboards',
          },
          {
            href: '/leaderboards/bonuses',
            label: 'Бонусы',
            labelKey: 'nav.bonusLeaderboard',
            hint: 'начисления экономики',
            hintKey: 'nav.hint.bonusLeaderboard',
            requiresEconomy: true,
          },
          {
            href: '/matches',
            label: 'Матчи',
            labelKey: 'nav.matches',
            hint: 'история игр',
            hintKey: 'nav.hint.matches',
          },
        ],
      },
      {
        label: 'Разбор',
        labelKey: 'nav.section.analysis',
        children: [
          {
            href: '/combat-log',
            label: 'Боевой лог',
            labelKey: 'nav.combatLog',
            hint: 'убийства, урон, поднятия',
            hintKey: 'nav.hint.combatLog',
          },
          {
            href: '/moderation/teamkills',
            label: 'Тимкиллы',
            labelKey: 'nav.teamkills',
            hint: 'огонь по своим',
            hintKey: 'nav.hint.teamkills',
          },
          {
            href: '/votes',
            label: 'Голосования',
            labelKey: 'nav.votes',
            hint: 'смена карты и кики',
            hintKey: 'nav.hint.votes',
          },
          {
            href: '/balancer',
            label: 'Балансировщик',
            labelKey: 'nav.balancer',
            hint: 'распределение по командам',
            hintKey: 'nav.hint.balancer',
            permission: 'balancer:view',
          },
        ],
      },
      {
        label: 'Обращения',
        labelKey: 'nav.section.requests',
        children: [
          {
            href: '/reports',
            label: 'Жалобы',
            labelKey: 'nav.reports',
            hint: 'от игроков',
            hintKey: 'nav.hint.reports',
            showsPendingReports: true,
          },
          {
            href: '/appeals',
            label: 'Апелляции',
            labelKey: 'nav.appeals',
            hint: 'обжалование банов',
            hintKey: 'nav.hint.appeals',
            permission: 'mod:unban',
          },
          {
            href: '/issues',
            label: 'Тикеты',
            labelKey: 'nav.issues',
            hint: 'внутренние задачи',
            hintKey: 'nav.hint.issues',
          },
        ],
      },
    ],
  },
  {
    label: 'Сообщество',
    labelKey: 'nav.group.community',
    items: [
      {
        href: '/clans',
        label: 'Кланы',
        labelKey: 'nav.clans',
        hint: 'составы и теги',
        hintKey: 'nav.hint.clans',
      },
      {
        href: '/events',
        label: 'События',
        labelKey: 'nav.events',
        hint: 'ивенты и расписание',
        hintKey: 'nav.hint.events',
      },
      {
        href: '/chat',
        label: 'Чат',
        labelKey: 'nav.chat',
        hint: 'игровой чат и броадкаст',
        hintKey: 'nav.hint.chat',
      },
      {
        href: '/notes',
        label: 'Заметки',
        labelKey: 'nav.notes',
        hint: 'внутренние записи',
        hintKey: 'nav.hint.notes',
      },
    ],
  },
  {
    label: 'Аудит',
    labelKey: 'nav.group.audit',
    items: [
      {
        href: '/audit',
        label: 'Журнал действий',
        labelKey: 'nav.audit',
        hint: 'кто что сделал',
        hintKey: 'nav.hint.audit',
      },
      {
        href: '/logs',
        label: 'Логи',
        labelKey: 'nav.logs',
        hint: 'сырые логи хоста и серверов',
        hintKey: 'nav.hint.logs',
        permission: 'host:view',
      },
    ],
  },
  {
    label: 'Настройки',
    labelKey: 'nav.group.settings',
    items: [
      {
        label: 'Панель',
        labelKey: 'nav.section.panel',
        children: [
          {
            href: '/settings/account',
            label: 'Аккаунт',
            labelKey: 'nav.account',
            hint: 'профиль и вход',
            hintKey: 'nav.hint.account',
          },
          {
            href: '/settings/groups',
            label: 'Группы',
            labelKey: 'nav.groups',
            hint: 'роли и права',
            hintKey: 'nav.hint.groups',
            permission: 'role:view',
          },
          {
            href: '/settings/tokens',
            label: 'API-токены',
            labelKey: 'nav.tokens',
            hint: 'ключи доступа',
            hintKey: 'nav.hint.tokens',
          },
          {
            href: '/settings/backup',
            label: 'Бэкапы',
            labelKey: 'nav.backup',
            hint: 'резервные копии',
            hintKey: 'nav.hint.backup',
            permission: 'host:manage',
          },
        ],
      },
      {
        label: 'Модерация',
        labelKey: 'nav.moderation',
        children: [
          {
            href: '/settings/mark-types',
            label: 'Типы меток',
            labelKey: 'nav.markTypes',
            hint: 'причины наблюдения',
            hintKey: 'nav.hint.markTypes',
            permission: 'role:edit',
          },
          {
            href: '/settings/chat-flags',
            label: 'Флаги чата',
            labelKey: 'nav.chatFlags',
            hint: 'стоп-слова',
            hintKey: 'nav.hint.chatFlags',
            permission: 'role:edit',
          },
          {
            href: '/settings/alt-detection',
            label: 'Альт-детект',
            labelKey: 'nav.altDetection',
            hint: 'поиск мультиаккаунтов',
            hintKey: 'nav.hint.altDetection',
            permission: 'player:view_ips',
          },
          {
            href: '/settings/whitelist',
            label: 'Whitelist',
            labelKey: 'nav.whitelist',
            hint: 'зарезервированные слоты',
            hintKey: 'nav.hint.whitelist',
            permission: 'whitelist:view',
          },
          {
            href: '/settings/clan-guard',
            label: 'Защита клан-тегов',
            labelKey: 'nav.clanGuard',
            hint: 'чужие теги',
            hintKey: 'nav.hint.clanGuard',
          },
          {
            href: '/settings/ban-sources',
            label: 'Источники банов',
            labelKey: 'nav.banSources',
            hint: 'внешние списки',
            hintKey: 'nav.hint.banSources',
          },
        ],
      },
      {
        label: 'Игра',
        labelKey: 'nav.section.game',
        children: [
          {
            href: '/settings/seasons',
            label: 'Сезоны',
            labelKey: 'nav.seasons',
            hint: 'периоды статистики',
            hintKey: 'nav.hint.seasons',
            permission: 'role:edit',
          },
          {
            href: '/settings/economy',
            label: 'Экономика',
            labelKey: 'nav.economy',
            hint: 'бонусы за онлайн',
            hintKey: 'nav.hint.economy',
          },
          {
            href: '/settings/message-templates',
            label: 'Шаблоны сообщений',
            labelKey: 'nav.messageTemplates',
            hint: 'ответы админов',
            hintKey: 'nav.hint.messageTemplates',
            permission: 'role:edit',
          },
          {
            href: '/settings/seed-notifications',
            label: 'Уведомления о сидинге',
            labelKey: 'nav.seedNotifications',
            hint: 'зов на пустой сервер',
            hintKey: 'nav.hint.seedNotifications',
          },
        ],
      },
      {
        label: 'Автоматика',
        labelKey: 'nav.section.automation',
        children: [
          {
            href: '/settings/alerts',
            label: 'Оповещения',
            labelKey: 'nav.alerts',
            hint: 'пороги и каналы',
            hintKey: 'nav.hint.alerts',
          },
          {
            href: '/settings/automation',
            label: 'Автоматизация',
            labelKey: 'nav.automation',
            hint: 'правила и триггеры',
            hintKey: 'nav.hint.automation',
          },
          {
            href: '/settings/integrations/discord',
            label: 'Discord',
            labelKey: 'nav.discord',
            hint: 'вебхуки и роли',
            hintKey: 'nav.hint.discord',
            permission: 'integration:manage',
          },
          {
            href: '/settings/integrations/geoip',
            label: 'GeoIP (MaxMind)',
            labelKey: 'nav.geoip',
            hint: 'база геолокации',
            hintKey: 'nav.hint.geoip',
            permission: 'integration:manage',
          },
          {
            href: '/settings/integrations/media',
            label: 'Публикация медиа',
            labelKey: 'nav.mediaPublishing',
            hint: 'скриншоты и клипы',
            hintKey: 'nav.hint.mediaPublishing',
            permission: 'integration:manage',
          },
        ],
      },
    ],
  },
];

/**
 * Flattens grouped nav items into a single list of navigable pages, dropping
 * group labels and expanding `children` columns into their sub-items (the
 * column header itself has no page of its own, so it is not included).
 */
export function flattenNavItems(groups: NavGroup[]): NavItem[] {
  return groups.flatMap((group) =>
    group.items.flatMap((item) => (item.children ? item.children : [item])),
  );
}

/** Whether `pathname` is `href` or a page nested under it. */
export function isNavHrefActive(pathname: string, href: string | undefined): boolean {
  return href !== undefined && (pathname === href || pathname.startsWith(`${href}/`));
}

/**
 * Finds the top-bar entry that owns `pathname`, so the bar can mark it active.
 *
 * Matching is longest-prefix, which is what makes nesting work: both
 * `/settings/groups` and `/settings/integrations/discord` live under the
 * settings entry, and `/servers/01a0/monitoring` under servers — while
 * `/dashboard` does not lose to a shorter accidental prefix.
 *
 * @param pathname Current location pathname.
 * @param groups Navigation tree; defaults to {@link NAV_GROUPS}.
 * @returns The owning group's `label`, `undefined` for the unlabeled bar links
 *   (which are matched by href instead), or `null` when nothing matches.
 */
export function activeNavGroupLabel(
  pathname: string,
  groups: NavGroup[] = NAV_GROUPS,
): string | null | undefined {
  let best: { label: string | undefined; length: number } | null = null;

  for (const group of groups) {
    for (const item of flattenNavItems([group])) {
      if (isNavHrefActive(pathname, item.href) && item.href !== undefined) {
        if (!best || item.href.length > best.length) {
          best = { label: group.label, length: item.href.length };
        }
      }
    }
  }

  return best ? best.label : null;
}
