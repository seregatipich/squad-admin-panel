// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push, replace: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/leaderboards/bonuses'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import BonusLeaderboardPage from './page';

const ROWS = [
  {
    rank: 1,
    player_id: 'p-rich',
    current_name: 'BonusRich',
    steam_id64: '76561198000000001',
    eos_id: 'eos-rich',
    value: 500,
    online_seconds: 9000,
  },
  {
    rank: 2,
    player_id: 'p-eos',
    current_name: 'BonusEosOnly',
    steam_id64: null,
    eos_id: 'eos-only',
    value: 300,
    online_seconds: 3600,
  },
];

function mockFetch(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

async function renderPage() {
  await act(async () => {
    render(<BonusLeaderboardPage />);
  });
}

describe('BonusLeaderboardPage', () => {
  it('renders rows with rank, name, value and online', async () => {
    mockFetch({
      period: 'all',
      available: true,
      economy_enabled: true,
      total_rows: 2,
      rows: ROWS,
    });
    await renderPage();

    const rich = await screen.findByRole('link', { name: 'BonusRich' });
    expect(rich).toHaveAttribute('href', '/all-players/p-rich');
    expect(screen.getByRole('link', { name: 'BonusEosOnly' })).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('300')).toBeInTheDocument();
    // 9000s → 2ч 30м; 3600s → 1ч 0м.
    expect(screen.getByText('2ч 30м')).toBeInTheDocument();
    expect(screen.getByText('1ч 0м')).toBeInTheDocument();
    expect(screen.getByText('🥇')).toBeInTheDocument();
    expect(screen.getByText('Баланс')).toBeInTheDocument();
  });

  it('reaches the player card through a real link, not a row click handler', async () => {
    mockFetch({
      period: 'all',
      available: true,
      economy_enabled: true,
      total_rows: 2,
      rows: ROWS,
    });
    await renderPage();

    const link = await screen.findByRole('link', { name: 'BonusRich' });
    expect(link).toHaveAttribute('href', '/all-players/p-rich');

    // Обычная ячейка никуда не ведёт: переход принадлежит ссылке в строке,
    // а не обработчику клика на `<tr>`.
    const cell = screen.getByText('500');
    await act(async () => {
      cell.click();
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('renders degrade state when available:false', async () => {
    mockFetch({
      period: 'all',
      available: false,
      economy_enabled: false,
      total_rows: 0,
      rows: [],
    });
    await renderPage();

    expect(
      await screen.findByText('Экономика отключена — лидерборд бонусов недоступен.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'BonusRich' })).not.toBeInTheDocument();
  });

  it('shows an empty state when nobody earned bonuses yet', async () => {
    mockFetch({
      period: 'all',
      available: true,
      economy_enabled: true,
      total_rows: 0,
      rows: [],
    });
    await renderPage();

    expect(await screen.findByText('Пока никто не заработал бонусов.')).toBeInTheDocument();
  });
});
