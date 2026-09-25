// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/clans'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import ClansPage from './page';

const CLANS_RESPONSE = {
  items: [
    {
      id: 'clan-1',
      name: 'Альфа',
      tags: ['ALF'],
      description: null,
      member_count: 3,
      priority_count: 1,
      max_priority_slots: 5,
      priority_expires_at: null,
      is_tag_protected: false,
      is_public: true,
      primary_server_id: null,
    },
  ],
  total: 1,
};

function mockFetch(canManageClans: boolean) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/clans')) {
      return Promise.resolve(new Response(JSON.stringify(CLANS_RESPONSE), { status: 200 }));
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/me')) {
      return Promise.resolve(
        new Response(JSON.stringify({ can_manage_clans: canManageClans }), { status: 200 }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ClansPage', () => {
  it('is a valid React component', () => {
    expect(ClansPage).toBeDefined();
    expect(typeof ClansPage).toBe('function');
  });

  it('renders the clan directory with a priority badge', async () => {
    vi.stubGlobal('fetch', mockFetch(false));
    render(<ClansPage />);
    expect(await screen.findByText('Альфа')).toBeInTheDocument();
    expect(screen.getByText('Бессрочно')).toBeInTheDocument();
  });

  it('hides the create button without can_manage_clans', async () => {
    vi.stubGlobal('fetch', mockFetch(false));
    render(<ClansPage />);
    await screen.findByText('Альфа');
    expect(screen.queryByRole('button', { name: 'Создать клан' })).not.toBeInTheDocument();
  });

  it('shows the create button with can_manage_clans', async () => {
    vi.stubGlobal('fetch', mockFetch(true));
    render(<ClansPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Создать клан' })).toBeInTheDocument();
    });
  });
});
