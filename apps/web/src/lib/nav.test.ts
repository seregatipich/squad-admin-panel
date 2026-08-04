import { describe, expect, it } from 'vitest';
import { ru } from '@/i18n/dictionaries/ru';
import { flattenNavItems, NAV_GROUPS } from './nav';

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

  it('gives "Игроки" a children group and no href of its own', () => {
    const management = NAV_GROUPS.find((group) => group.label === 'Управление');
    const players = management?.items.find((item) => item.label === 'Игроки');
    expect(players?.href).toBeUndefined();
    expect(players?.children?.length).toBeGreaterThan(0);
  });

  it('exposes the team balancer under «Инструменты», gated on balancer:view (GAME-2, #81)', () => {
    const management = NAV_GROUPS.find((group) => group.label === 'Управление');
    const tools = management?.items.find((item) => item.label === 'Инструменты');
    expect(tools?.children).toContainEqual({
      href: '/balancer',
      label: 'Балансировщик',
      labelKey: 'nav.balancer',
      permission: 'balancer:view',
    });
  });

  it('gives "Инструменты" a children group with the stats/moderation-tool pages and no href of its own', () => {
    const management = NAV_GROUPS.find((group) => group.label === 'Управление');
    const tools = management?.items.find((item) => item.label === 'Инструменты');
    expect(tools?.href).toBeUndefined();
    expect(tools?.children?.map((c) => c.label)).toEqual([
      'Статистика',
      'Лидерборды',
      'Матчи',
      'Балансировщик',
      'Боевой лог',
      'Тимкиллы',
      'Голосования',
      'Жалобы',
      'Апелляции',
      'Тикеты',
    ]);
  });

  it('gives «Модерация» a children group with the moderation/access-control settings pages and no href of its own', () => {
    const settings = NAV_GROUPS.find((group) => group.label === 'Настройки');
    const moderation = settings?.items.find((item) => item.label === 'Модерация');
    expect(moderation?.href).toBeUndefined();
    expect(moderation?.children?.map((c) => c.label)).toEqual([
      'Типы меток',
      'Флаги чата',
      'Альт-детект',
      'Whitelist',
      'Защита клан-тегов',
      'Источники банов',
    ]);
  });

  it('gives «Уведомления» a children group with the alert/automation settings pages and no href of its own', () => {
    const settings = NAV_GROUPS.find((group) => group.label === 'Настройки');
    const notifications = settings?.items.find((item) => item.label === 'Уведомления');
    expect(notifications?.href).toBeUndefined();
    expect(notifications?.children?.map((c) => c.label)).toEqual([
      'Оповещения',
      'Автоматизация',
      'Уведомления о сидинге',
    ]);
  });

  it('gives «Интеграции» a children group with the third-party integration pages and no href of its own', () => {
    const settings = NAV_GROUPS.find((group) => group.label === 'Настройки');
    const integrations = settings?.items.find((item) => item.label === 'Интеграции');
    expect(integrations?.href).toBeUndefined();
    expect(integrations?.children?.map((c) => c.label)).toEqual([
      'Discord',
      'GeoIP (MaxMind)',
      'Публикация медиа',
    ]);
  });

  it('leaves only «Журнал действий» and «Логи» under «Аудит» now that teamkills moved into «Инструменты»', () => {
    const audit = NAV_GROUPS.find((group) => group.label === 'Аудит');
    expect(audit?.items.map((item) => item.label)).toEqual(['Журнал действий', 'Логи']);
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
