// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { PALETTE_OPEN_EVENT } from '@/lib/commandPalette';
import { NAV_GROUPS } from '@/lib/nav';

const mockUsePathname = vi.fn(() => '/dashboard');
vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: vi.fn(),
}));

// The bar fetches a pending-reports count on mount; each test decides the total.
const fetchMock = vi.fn(() =>
  Promise.resolve(new Response(JSON.stringify({ total: 0 }), { status: 200 })),
);
vi.stubGlobal('fetch', fetchMock);

import { TopNav } from './TopNav';

const ALL_PERMISSIONS = [
  'server:view',
  'server:install',
  'user:view',
  'balancer:view',
  'mod:unban',
  'role:view',
  'role:edit',
  'host:view',
  'host:manage',
  'player:view_ips',
  'whitelist:view',
  'integration:manage',
];

function renderNav(props: Partial<Parameters<typeof TopNav>[0]> = {}) {
  return render(
    <LocaleProvider locale="ru">
      <TopNav permissions={ALL_PERMISSIONS} displayName="Alice" groups={NAV_GROUPS} {...props} />
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  mockUsePathname.mockReturnValue('/dashboard');
  fetchMock.mockClear();
});

describe('TopNav', () => {
  it('renders the dashboard as a direct bar link and every other entry as a menu button', () => {
    renderNav();
    expect(screen.getByRole('link', { name: 'Дашборд' })).toHaveAttribute('href', '/dashboard');
    for (const label of ['Серверы', 'Игроки', 'Инструменты', 'Сообщество', 'Аудит', 'Настройки']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
  });

  it('keeps a dropdown closed until its trigger is clicked, and closes it again', () => {
    renderNav();
    const trigger = screen.getByRole('button', { name: /^Игроки/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menuitem', { name: /Все игроки/ })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: /Все игроки/ })).toHaveAttribute(
      'href',
      '/all-players',
    );

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menuitem', { name: /Все игроки/ })).not.toBeInTheDocument();
  });

  it('closes an open menu on Escape and on a click outside the bar', () => {
    renderNav();
    const trigger = screen.getByRole('button', { name: /^Игроки/ });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders «Настройки» as a mega-menu with a column header per section', () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: /^Настройки/ }));
    for (const column of ['Панель', 'Модерация', 'Игра', 'Автоматика']) {
      expect(screen.getByText(column)).toBeInTheDocument();
    }
    expect(screen.getByRole('menuitem', { name: /Группы/ })).toHaveAttribute(
      'href',
      '/settings/groups',
    );
  });

  it('hides items the user has no permission for, and the whole entry when nothing is left', () => {
    renderNav({ permissions: [] });
    // Every «Аудит» item but the audit log itself is gated; the entry survives.
    fireEvent.click(screen.getByRole('button', { name: /^Аудит/ }));
    expect(screen.getByRole('menuitem', { name: /Журнал действий/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Логи/ })).not.toBeInTheDocument();

    // Every «Серверы» item is gated on server permissions — the entry goes.
    expect(screen.queryByRole('button', { name: /^Серверы/ })).not.toBeInTheDocument();
  });

  it('hides the bonus leaderboard while the economy module is off (ECON-5, #165)', () => {
    renderNav({ economyEnabled: false });
    fireEvent.click(screen.getByRole('button', { name: /^Инструменты/ }));
    expect(screen.queryByRole('menuitem', { name: /Бонусы/ })).not.toBeInTheDocument();

    cleanup();
    renderNav({ economyEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: /^Инструменты/ }));
    expect(screen.getByRole('menuitem', { name: /Бонусы/ })).toHaveAttribute(
      'href',
      '/leaderboards/bonuses',
    );
  });

  it('marks the owning entry active for a nested page', () => {
    mockUsePathname.mockReturnValue('/settings/integrations/discord');
    renderNav();
    // `classList` rather than a substring match: every trigger carries
    // `hover:bg-raised/60`, which contains the active class as a substring.
    expect(screen.getByRole('button', { name: /^Настройки/ }).classList).toContain('bg-raised');
    expect(screen.getByRole('button', { name: /^Игроки/ }).classList).not.toContain('bg-raised');
  });

  it('marks the dashboard link as the current page via aria-current', () => {
    renderNav();
    expect(screen.getByRole('link', { name: 'Дашборд' })).toHaveAttribute('aria-current', 'page');
  });

  it('badges the pending-reports queue on the closed «Инструменты» trigger and on «Жалобы»', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ total: 4 }), { status: 200 }));
    renderNav();

    const trigger = await screen.findByRole('button', { name: /^Инструменты/ });
    await waitFor(() => expect(trigger).toHaveTextContent('4'));

    fireEvent.click(trigger);
    // Open, the count moves onto the item it actually describes.
    expect(screen.getByRole('menuitem', { name: /Жалобы/ })).toHaveTextContent('4');
    expect(trigger).not.toHaveTextContent('4');
  });

  it('caps the pending-reports badge at 99+', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ total: 250 }), { status: 200 }));
    renderNav();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Инструменты/ })).toHaveTextContent('99+'),
    );
  });

  it('asks the command palette to open when the search field is clicked', () => {
    const onOpen = vi.fn();
    window.addEventListener(PALETTE_OPEN_EVENT, onOpen);
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: /Поиск по панели/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(PALETTE_OPEN_EVENT, onOpen);
  });

  it('puts the account, tokens and logout behind the user menu', () => {
    renderNav({ displayName: 'seregatipich' });
    const trigger = screen.getByRole('button', { name: 'Меню пользователя' });
    expect(trigger).toHaveTextContent('seregatipich');
    expect(screen.queryByRole('menuitem', { name: 'Аккаунт' })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Аккаунт' })).toHaveAttribute(
      'href',
      '/settings/account',
    );
    expect(screen.getByRole('menuitem', { name: 'API-токены' })).toHaveAttribute(
      'href',
      '/settings/tokens',
    );
    expect(screen.getByRole('menuitem', { name: 'Выйти' })).toBeInTheDocument();
    // Переключатель языка — элемент управления, а не команда меню, поэтому он
    // живёт в самой полосе и доступен без открытия меню.
    expect(screen.getByRole('group', { name: 'Язык' })).toBeInTheDocument();
  });

  it('walks an open menu with the keyboard and returns focus on Escape', () => {
    renderNav();
    const trigger = screen.getByRole('button', { name: /^Игроки/ });

    // Стрелка вниз и открывает меню, и ставит фокус на первый пункт: до этого
    // выпадающие списки панели вообще не отвечали на клавиатуру.
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(items[1], { key: 'Home' });
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(items[0], { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('exposes each dropdown as a menu rather than a list of links', () => {
    renderNav();
    const trigger = screen.getByRole('button', { name: /^Игроки/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('renders the English labels under the English locale', () => {
    render(
      <LocaleProvider locale="en">
        <TopNav permissions={ALL_PERMISSIONS} displayName="Alice" groups={NAV_GROUPS} />
      </LocaleProvider>,
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Players/ }));
    expect(screen.getByRole('menuitem', { name: /All players/ })).toHaveAttribute(
      'href',
      '/all-players',
    );
  });
});
