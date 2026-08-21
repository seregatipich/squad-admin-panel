import { describe, expect, it } from 'vitest';
import { ru } from '@/i18n/dictionaries/ru';
import { activeNavGroupLabel, flattenNavItems, isNavHrefActive, NAV_GROUPS } from './nav';

describe('NAV_GROUPS', () => {
  it('contains the dashboard as the first item', () => {
    expect(NAV_GROUPS[0]?.items[0]).toEqual({
      href: '/dashboard',
      label: 'Дашборд',
      labelKey: 'nav.dashboard',
    });
  });

  it('has unique hrefs across every group', () => {
    const hrefs = flattenNavItems(NAV_GROUPS).map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('gives every item, child item, and labeled group a labelKey', () => {
    for (const group of NAV_GROUPS) {
      if (group.label) expect(group.labelKey, `group ${group.label}`).toBeDefined();
      for (const item of group.items) {
        expect(item.labelKey, `item ${item.label}`).toBeDefined();
        for (const child of item.children ?? []) {
          expect(child.labelKey, `child ${child.label}`).toBeDefined();
        }
      }
    }
  });

  it('gives «Игроки» its own top-bar entry listing every player page in order', () => {
    const players = NAV_GROUPS.find((group) => group.label === 'Игроки');
    expect(players?.items.map((item) => item.href)).toEqual([
      '/all-players',
      '/suspects',
      '/banned-names',
      '/external-bans',
      '/vips',
      '/users',
    ]);
    expect(players?.items.find((item) => item.href === '/vips')?.permission).toBe('user:view');
    expect(players?.items.find((item) => item.href === '/users')?.permission).toBe('user:view');
  });

  it('exposes the team balancer under «Инструменты» → «Разбор», gated on balancer:view (GAME-2, #81)', () => {
    const tools = NAV_GROUPS.find((group) => group.label === 'Инструменты');
    const analysis = tools?.items.find((item) => item.label === 'Разбор');
    const balancer = analysis?.children?.find((child) => child.href === '/balancer');
    expect(balancer?.permission).toBe('balancer:view');
  });

  it('splits «Инструменты» into the statistics, analysis and requests columns', () => {
    const tools = NAV_GROUPS.find((group) => group.label === 'Инструменты');
    expect(tools?.items.map((item) => item.label)).toEqual(['Статистика', 'Разбор', 'Обращения']);
    for (const column of tools?.items ?? []) expect(column.href).toBeUndefined();
    expect(tools?.items.flatMap((c) => c.children ?? []).map((c) => c.href)).toEqual([
      '/statistics',
      '/leaderboards',
      '/leaderboards/bonuses',
      '/matches',
      '/combat-log',
      '/moderation/teamkills',
      '/votes',
      '/balancer',
      '/reports',
      '/appeals',
      '/issues',
    ]);
  });

  it('keeps the bonus leaderboard gated on the economy module (ECON-5, #165)', () => {
    const tools = NAV_GROUPS.find((group) => group.label === 'Инструменты');
    const bonuses = tools?.items
      .flatMap((column) => column.children ?? [])
      .find((child) => child.href === '/leaderboards/bonuses');
    expect(bonuses?.requiresEconomy).toBe(true);
  });

  it('flags «Жалобы» as the item carrying the pending-reports badge', () => {
    const withBadge = flattenNavItems(NAV_GROUPS).filter((item) => item.showsPendingReports);
    expect(withBadge.map((item) => item.href)).toEqual(['/reports']);
  });

  it('splits «Настройки» into the panel, moderation, game and automation columns', () => {
    const settings = NAV_GROUPS.find((group) => group.label === 'Настройки');
    expect(settings?.items.map((item) => item.label)).toEqual([
      'Панель',
      'Модерация',
      'Игра',
      'Автоматика',
    ]);
    for (const column of settings?.items ?? []) expect(column.href).toBeUndefined();
  });

  it('keeps «Модерация» pointing at the moderation/access-control settings pages', () => {
    const settings = NAV_GROUPS.find((group) => group.label === 'Настройки');
    const moderation = settings?.items.find((item) => item.label === 'Модерация');
    expect(moderation?.children?.map((c) => c.label)).toEqual([
      'Типы меток',
      'Флаги чата',
      'Альт-детект',
      'Whitelist',
      'Защита клан-тегов',
      'Источники банов',
    ]);
  });

  it('keeps every third-party integration page gated on integration:manage', () => {
    const integrations = flattenNavItems(NAV_GROUPS).filter((item) =>
      item.href?.startsWith('/settings/integrations/'),
    );
    expect(integrations.map((item) => item.href)).toEqual([
      '/settings/integrations/discord',
      '/settings/integrations/geoip',
      '/settings/integrations/media',
    ]);
    for (const item of integrations) expect(item.permission).toBe('integration:manage');
  });

  it('surfaces the servers list and the create-server page the sidebar never linked', () => {
    const servers = NAV_GROUPS.find((group) => group.label === 'Серверы');
    expect(servers?.items.map((item) => item.href)).toEqual([
      '/servers',
      '/servers/new',
      '/servers/archive',
    ]);
    expect(servers?.items.find((item) => item.href === '/servers/new')?.permission).toBe(
      'server:install',
    );
  });

  it('gives «Сообщество» the clan, event, chat and note pages', () => {
    const community = NAV_GROUPS.find((group) => group.label === 'Сообщество');
    expect(community?.items.map((item) => item.href)).toEqual([
      '/clans',
      '/events',
      '/chat',
      '/notes',
    ]);
  });

  it('leaves only «Журнал действий» and «Логи» under «Аудит» — teamkills live under «Инструменты»', () => {
    const audit = NAV_GROUPS.find((group) => group.label === 'Аудит');
    expect(audit?.items.map((item) => item.label)).toEqual(['Журнал действий', 'Логи']);
  });

  it('gives every dropdown hint a hintKey that matches the Russian source (drift guard)', () => {
    for (const item of flattenNavItems(NAV_GROUPS)) {
      if (item.hint) {
        expect(item.hintKey, `hint for ${item.label}`).toBeDefined();
        if (item.hintKey) expect(ru[item.hintKey], item.label).toBe(item.hint);
      }
    }
  });

  it('keeps the Russian dictionary in sync with the legacy `label` (drift guard)', () => {
    for (const group of NAV_GROUPS) {
      if (group.label && group.labelKey) expect(ru[group.labelKey]).toBe(group.label);
      for (const item of group.items) {
        if (item.labelKey) expect(ru[item.labelKey], item.label).toBe(item.label);
        for (const child of item.children ?? []) {
          if (child.labelKey) expect(ru[child.labelKey], child.label).toBe(child.label);
        }
      }
    }
  });
});

describe('flattenNavItems', () => {
  it('drops group labels and concatenates items in order', () => {
    const flat = flattenNavItems([
      { items: [{ href: '/a', label: 'A' }] },
      { label: 'Group', items: [{ href: '/b', label: 'B', permission: 'x:view' }] },
    ]);
    expect(flat).toEqual([
      { href: '/a', label: 'A' },
      { href: '/b', label: 'B', permission: 'x:view' },
    ]);
  });

  it('expands a group item into its children instead of the group header itself', () => {
    const flat = flattenNavItems([
      {
        label: 'Group',
        items: [
          {
            label: 'Parent',
            children: [
              { href: '/a', label: 'A' },
              { href: '/b', label: 'B' },
            ],
          },
        ],
      },
    ]);
    expect(flat).toEqual([
      { href: '/a', label: 'A' },
      { href: '/b', label: 'B' },
    ]);
  });

  it('returns an empty list for no groups', () => {
    expect(flattenNavItems([])).toEqual([]);
  });
});

describe('isNavHrefActive', () => {
  it('matches the page itself and anything nested under it', () => {
    expect(isNavHrefActive('/servers', '/servers')).toBe(true);
    expect(isNavHrefActive('/servers/abc/monitoring', '/servers')).toBe(true);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    expect(isNavHrefActive('/serversomething', '/servers')).toBe(false);
    expect(isNavHrefActive('/all-players', '/servers')).toBe(false);
  });

  it('never matches an item with no page of its own', () => {
    expect(isNavHrefActive('/servers', undefined)).toBe(false);
  });
});

describe('activeNavGroupLabel', () => {
  it('resolves a nested page to the top-bar entry that owns it', () => {
    expect(activeNavGroupLabel('/servers/01a0/monitoring')).toBe('Серверы');
    expect(activeNavGroupLabel('/settings/integrations/discord')).toBe('Настройки');
    expect(activeNavGroupLabel('/moderation/teamkills')).toBe('Инструменты');
    expect(activeNavGroupLabel('/clans/7/roster')).toBe('Сообщество');
  });

  it('prefers the longest matching href when two entries share a prefix', () => {
    // `/leaderboards` and `/leaderboards/bonuses` both live under
    // «Инструменты», and `/settings/groups` must not lose to a shorter match.
    expect(activeNavGroupLabel('/leaderboards/bonuses')).toBe('Инструменты');
    expect(activeNavGroupLabel('/settings/groups')).toBe('Настройки');
  });

  it('returns undefined for a bar link that belongs to no labeled entry', () => {
    expect(activeNavGroupLabel('/dashboard')).toBeUndefined();
  });

  it('returns null when no entry owns the path', () => {
    expect(activeNavGroupLabel('/nowhere')).toBeNull();
  });
});
