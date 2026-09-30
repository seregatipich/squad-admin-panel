// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('asks the API for the search, sort and page instead of filtering in the browser (#524)', async () => {
    const fetchSpy = mockFetch(false);
    vi.stubGlobal('fetch', fetchSpy);
    render(<ClansPage />);
    await screen.findByText('Альфа');

    const clanUrls = fetchSpy.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.startsWith('/api/v1/clans'));
    expect(clanUrls).toEqual(['/api/v1/clans?sort=name&order=asc&page=1&limit=25']);
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

  it('does not claim no clans exist when the load fails (#525)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/v1/clans')) {
          return Promise.resolve(new Response('fail', { status: 500 }));
        }
        if (url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        if (url.startsWith('/api/v1/me')) {
          return Promise.resolve(
            new Response(JSON.stringify({ can_manage_clans: false }), { status: 200 }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    render(<ClansPage />);
    expect(await screen.findByText('Не удалось загрузить кланы')).toBeInTheDocument();
    expect(screen.queryByText('Кланы ещё не созданы')).not.toBeInTheDocument();
  });

  it('resets the create-clan form on close instead of keeping stale input (#526)', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', mockFetch(true));
    render(<ClansPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Создать клан' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Создать клан' }));
    const nameInput = await screen.findByLabelText('Название');
    await user.type(nameInput, 'Черновик');
    expect(nameInput).toHaveValue('Черновик');

    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    await user.click(screen.getByRole('button', { name: 'Создать клан' }));
    const reopenedInput = await screen.findByLabelText('Название');
    expect(reopenedInput).toHaveValue('');
  });
});
