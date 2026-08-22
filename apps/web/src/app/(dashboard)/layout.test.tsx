import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => true }),
}));
// Mirrors Next's real `redirect`, which throws to abort rendering — without
// that the guard under test would fall through and render the admin shell
// anyway, so the assertion would pass for the wrong reason.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock('@/lib/dal', () => ({
  requireSession: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));
vi.mock('@/components/connection-banner', () => ({
  ConnectionBanner: () => null,
}));
vi.mock('@/components/TopNav', () => ({
  TopNav: () => null,
}));
vi.mock('@/components/ServerBar', () => ({
  ServerBar: () => null,
}));
vi.mock('@/components/CommandPalette', () => ({
  CommandPalette: () => null,
}));

import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { requireSession } from '@/lib/dal';
import DashboardLayout from './layout';

const redirectMock = vi.mocked(redirect);
const requireSessionMock = vi.mocked(requireSession);
const apiFetchMock = vi.mocked(apiFetch);

function session(permissions: string[]) {
  return {
    player_id: 'player-1',
    steam_id64: '76561198000000001',
    canonical_name: 'TestUser',
    avatar_url: null,
    permissions,
    squad_permissions: [],
  };
}

beforeEach(() => {
  redirectMock.mockClear();
  requireSessionMock.mockReset();
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ setup_completed: true });
});

describe('DashboardLayout', () => {
  it('is a valid async function component', () => {
    expect(DashboardLayout).toBeDefined();
    expect(typeof DashboardLayout).toBe('function');
  });

  // VIPSUB-5 (#171) made a session possible without `panel_access`, and
  // `GET /api/v1/me` is `selfService`, so `requireSession()` alone no longer
  // proves the caller may see the panel. Without this guard such a player can
  // navigate straight to a `(dashboard)` URL and get the admin shell with an
  // empty sidebar over content that 401s.
  it('sends a panel-less self-service session to /me', async () => {
    requireSessionMock.mockResolvedValue(session([]));
    await expect(DashboardLayout({ children: null })).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectMock).toHaveBeenCalledWith('/me');
  });

  it('renders the shell for a session that holds panel permissions', async () => {
    requireSessionMock.mockResolvedValue(session(['servers.view']));
    await expect(DashboardLayout({ children: null })).resolves.toBeTruthy();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  // #225: `redirect()` aborts by throwing, so calling it inside the
  // setup-status `try` let the bare `catch` swallow it — an unfinished panel
  // rendered the dashboard instead of being sent to `/setup`.
  it('sends a session to /setup while setup is incomplete', async () => {
    requireSessionMock.mockResolvedValue(session(['servers.view']));
    apiFetchMock.mockResolvedValue({ setup_completed: false });
    await expect(DashboardLayout({ children: null })).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirectMock).toHaveBeenCalledWith('/setup');
  });

  // The `catch` still has a job: a setup-status outage must not lock the panel.
  it('renders the shell when the setup-status endpoint fails', async () => {
    requireSessionMock.mockResolvedValue(session(['servers.view']));
    apiFetchMock.mockRejectedValue(new Error('api down'));
    await expect(DashboardLayout({ children: null })).resolves.toBeTruthy();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
