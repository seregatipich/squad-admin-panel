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
vi.mock('./MeBrowser', () => ({
  MeBrowser: ({ displayName }: { displayName: string }) => <p>кабинет: {displayName}</p>,
}));

import { requireSession } from '@/lib/dal';
import MePage, { dynamic } from './page';

const requireSessionMock = vi.mocked(requireSession);

beforeEach(() => {
  requireSessionMock.mockReset();
});
afterEach(cleanup);

describe('MePage', () => {
  it('hands the session player name to the self-service browser', async () => {
    requireSessionMock.mockResolvedValue({
      player_id: 'player-1',
      steam_id64: '76561198000000001',
      canonical_name: 'VipPlayer',
      avatar_url: null,
      permissions: [],
      squad_permissions: [],
    });

    render(await MePage());

    expect(screen.getByText('кабинет: VipPlayer')).toBeInTheDocument();
  });

  it('is rendered per request, never statically', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('propagates the login redirect when there is no session', async () => {
    requireSessionMock.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));

    await expect(MePage()).rejects.toThrow('NEXT_REDIRECT:/login');
  });
});
