// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => true }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock('@/lib/dal', () => ({ requireSession: vi.fn() }));

import { requireSession } from '@/lib/dal';
import MeLayout from './layout';

const requireSessionMock = vi.mocked(requireSession);

const SELF_SERVICE_SESSION = {
  player_id: 'player-1',
  steam_id64: '76561198000000001',
  canonical_name: 'VipPlayer',
  avatar_url: null,
  permissions: [],
  squad_permissions: [],
};

beforeEach(() => {
  requireSessionMock.mockReset();
});
afterEach(cleanup);

describe('MeLayout', () => {
  it('shows the cabinet title, the player name, the logout button and the page content', async () => {
    requireSessionMock.mockResolvedValue(SELF_SERVICE_SESSION);

    render(await MeLayout({ children: <p>содержимое страницы</p> }));

    expect(screen.getByText('Личный кабинет')).toBeInTheDocument();
    expect(screen.getByText('VipPlayer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('содержимое страницы');
  });

  it('renders no panel navigation, which a self-service session cannot use', async () => {
    requireSessionMock.mockResolvedValue(SELF_SERVICE_SESSION);

    render(await MeLayout({ children: null }));

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('does not render when the session guard redirects to login', async () => {
    requireSessionMock.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));

    await expect(MeLayout({ children: <p>секрет</p> })).rejects.toThrow('NEXT_REDIRECT:/login');
  });
});
