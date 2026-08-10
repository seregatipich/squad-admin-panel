import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors Next's real `redirect`, which throws to abort rendering — without
// that the `never` return type would not hold at runtime and the page would
// keep executing past the branch under test.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock('@/lib/dal', () => ({
  getSession: vi.fn(),
}));

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/dal';
import Page from './page';

const redirectMock = vi.mocked(redirect);
const getSessionMock = vi.mocked(getSession);

function session(permissions: string[]) {
  return {
    player_id: 'player-1',
    steam_id64: '1',
    canonical_name: 'Test',
    avatar_url: null,
    permissions,
    squad_permissions: [],
  };
}

beforeEach(() => {
  redirectMock.mockClear();
  getSessionMock.mockReset();
});

/** Runs the page and swallows the redirect throw, leaving the mock to assert on. */
async function renderPage(): Promise<void> {
  await expect(Page()).rejects.toThrow(/NEXT_REDIRECT/);
}

describe('RootPage', () => {
  it('is a valid async function component', () => {
    expect(Page).toBeDefined();
    expect(typeof Page).toBe('function');
  });

  it('sends an anonymous visitor to the login page', async () => {
    getSessionMock.mockResolvedValue(null);
    await renderPage();
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('sends a panel user to the dashboard', async () => {
    getSessionMock.mockResolvedValue(session(['player:view']));
    await renderPage();
    expect(redirectMock).toHaveBeenCalledWith('/dashboard');
  });

  it('sends a permissionless self-service player to /me', async () => {
    getSessionMock.mockResolvedValue(session([]));
    await renderPage();
    expect(redirectMock).toHaveBeenCalledWith('/me');
    expect(redirectMock).not.toHaveBeenCalledWith('/dashboard');
  });
});
