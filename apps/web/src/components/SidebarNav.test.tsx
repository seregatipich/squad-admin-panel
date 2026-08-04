// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';

const mockUsePathname = vi.fn(() => '/dashboard');
vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The sidebar fetches a pending-reports count on mount; keep it inert.
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve(new Response(JSON.stringify({ total: 0 }), { status: 200 }))),
);

import { SidebarNav } from './SidebarNav';

afterEach(() => {
  cleanup();
  mockUsePathname.mockReturnValue('/dashboard');
});

describe('SidebarNav', () => {
  it('exports a React component function', () => {
    expect(typeof SidebarNav).toBe('function');
  });

  it('nests "Все игроки", "Метки", "Забаненные ники", "Внешние баны", "VIP" and "Администрация" under the "Игроки" group inside "Управление"', async () => {
    const { NAV_GROUPS } = await import('@/lib/nav');
    const managementGroup = NAV_GROUPS.find((g) => g.label === 'Управление');
    const playersGroup = managementGroup?.items.find((item) => item.label === 'Игроки');
    expect(playersGroup?.href).toBeUndefined();
    expect(playersGroup?.children?.map((c) => c.label)).toEqual([
      'Все игроки',
      'Метки',
      'Забаненные ники',
      'Внешние баны',
      'VIP',
      'Администрация',
    ]);
    const vipsItem = playersGroup?.children?.find((item) => item.href === '/vips');
    expect(vipsItem).toEqual({
      href: '/vips',
      label: 'VIP',
      labelKey: 'nav.vips',
      permission: 'user:view',
    });
  });

  it('renders "Игроки" as a toggle button, not a link, and expands/collapses its children on click', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={[]} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.queryByRole('link', { name: 'Игроки' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Игроки' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Все игроки' })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Все игроки' })).toHaveAttribute(
      'href',
      '/all-players',
    );
    expect(screen.getByRole('link', { name: 'Метки' })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Все игроки' })).not.toBeInTheDocument();
  });

  it('auto-expands "Игроки" when the active route is one of its children', () => {
    mockUsePathname.mockReturnValue('/vips');
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={['user:view']} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Игроки' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'VIP' })).toHaveAttribute('aria-current', 'page');
  });

  it('hides "Администрация" and "VIP" under "Игроки" without user:view, but keeps the rest of the group', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={[]} displayName="Alice" />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Игроки' }));
    expect(screen.getByRole('link', { name: 'Все игроки' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'VIP' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Администрация' })).not.toBeInTheDocument();
  });

  it('renders "Инструменты" as a toggle button, not a link, and expands/collapses its children on click', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={[]} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.queryByRole('link', { name: 'Инструменты' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Инструменты' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Статистика' })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Статистика' })).toHaveAttribute('href', '/statistics');
    expect(screen.getByRole('link', { name: 'Тимкиллы' })).toHaveAttribute(
      'href',
      '/moderation/teamkills',
    );

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Статистика' })).not.toBeInTheDocument();
  });

  it('auto-expands "Инструменты" when the active route is one of its children', () => {
    mockUsePathname.mockReturnValue('/balancer');
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={['balancer:view']} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Инструменты' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Балансировщик' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('hides economy-gated items when economy is disabled', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={[]} displayName="Alice" economyEnabled={false} />
      </LocaleProvider>,
    );
    expect(screen.queryByRole('link', { name: 'Бонусы' })).not.toBeInTheDocument();
    // The regular leaderboards item (nested under "Инструменты") stays visible either way.
    fireEvent.click(screen.getByRole('button', { name: 'Инструменты' }));
    expect(screen.getByRole('link', { name: 'Лидерборды' })).toBeInTheDocument();
  });

  it('shows economy-gated items when economy is enabled', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={[]} displayName="Alice" economyEnabled />
      </LocaleProvider>,
    );
    const bonuses = screen.getByRole('link', { name: 'Бонусы' });
    expect(bonuses).toHaveAttribute('href', '/leaderboards/bonuses');
  });

  it('hides economy-gated items when the flag is omitted (defaults off)', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={[]} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.queryByRole('link', { name: 'Бонусы' })).not.toBeInTheDocument();
  });

  it('nests "Типы меток", "Флаги чата", "Альт-детект", "Whitelist", "Защита клан-тегов" and "Источники банов" under the "Модерация" group inside "Настройки"', async () => {
    const { NAV_GROUPS } = await import('@/lib/nav');
    const settingsGroup = NAV_GROUPS.find((g) => g.label === 'Настройки');
    const moderationGroup = settingsGroup?.items.find((item) => item.label === 'Модерация');
    expect(moderationGroup?.href).toBeUndefined();
    expect(moderationGroup?.children?.map((c) => c.label)).toEqual([
      'Типы меток',
      'Флаги чата',
      'Альт-детект',
      'Whitelist',
      'Защита клан-тегов',
      'Источники банов',
    ]);
  });

  it('renders "Модерация" as a toggle button, not a link, and expands/collapses its children on click', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav
          permissions={['role:edit', 'player:view_ips', 'whitelist:view']}
          displayName="Alice"
        />
      </LocaleProvider>,
    );
    expect(screen.queryByRole('link', { name: 'Модерация' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Модерация' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Флаги чата' })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Флаги чата' })).toHaveAttribute(
      'href',
      '/settings/chat-flags',
    );
    expect(screen.getByRole('link', { name: 'Защита клан-тегов' })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Флаги чата' })).not.toBeInTheDocument();
  });

  it('auto-expands "Уведомления" when the active route is one of its children', () => {
    mockUsePathname.mockReturnValue('/settings/automation');
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={[]} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Уведомления' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Автоматизация' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('hides the whole "Интеграции" group without integration:manage, since none of its children are visible', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={[]} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Интеграции' })).not.toBeInTheDocument();
  });

  it('shows "Интеграции" with Discord, GeoIP and media publishing once integration:manage is granted', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={['integration:manage']} displayName="Alice" />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Интеграции' }));
    expect(screen.getByRole('link', { name: 'Discord' })).toHaveAttribute(
      'href',
      '/settings/integrations/discord',
    );
    expect(screen.getByRole('link', { name: 'GeoIP (MaxMind)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Публикация медиа' })).toBeInTheDocument();
  });

  it('keeps ungrouped settings pages like "Аккаунт" as direct links', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={[]} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('link', { name: 'Аккаунт' })).toHaveAttribute(
      'href',
      '/settings/account',
    );
  });

  it('renders navigation labels in Russian', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={['user:view']} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('link', { name: 'Дашборд' })).toBeInTheDocument();
    expect(screen.getByText('Управление')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
  });

  it('renders the same navigation in English', () => {
    render(
      <LocaleProvider locale="en">
        <SidebarNav permissions={['user:view']} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Management')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.queryByText('Дашборд')).not.toBeInTheDocument();
  });
});
