// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/clans/x'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import ClanDetailPage from './page';

const TEST_TIMEOUT_MS = 15_000;

const CLAN = {
  id: 'clan-1',
  name: 'Альфа',
  tags: ['ALF'],
  description: 'Описание клана',
  is_tag_protected: false,
  is_public: true,
  max_priority_slots: 10,
  priority_count: 0,
  priority_expires_at: null,
  primary_server_id: null,
};

function json(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/v1/clans/clan-1') return json(CLAN);
    if (url === '/api/v1/clans/clan-1/online') return json({ clan_id: 'clan-1', servers: [] });
    if (url.startsWith('/api/v1/clans/clan-1/matches')) {
      return json({ clan_id: 'clan-1', items: [], next_cursor: null, limit: 20 });
    }
    if (url === '/api/v1/servers') return json({ items: [] });
    if (url === '/api/v1/me') return json({ can_manage_clans: true });
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ClanDetailPage', () => {
  it('is a valid React component', () => {
    expect(ClanDetailPage).toBeDefined();
    expect(typeof ClanDetailPage).toBe('function');
  });

  it(
    'keeps the clan settings draft across the page’s one-second session ticker',
    async () => {
      vi.stubGlobal('fetch', mockFetch());
      const params = Promise.resolve({ id: 'clan-1' });
      await act(async () => {
        render(
          <Suspense fallback={null}>
            <ClanDetailPage params={params} />
          </Suspense>,
        );
      });

      const nameInput = await screen.findByDisplayValue('Альфа');
      fireEvent.change(nameInput, { target: { value: 'Альфа Прайм' } });

      // Тикер длительности сессий перерисовывает страницу раз в секунду.
      await act(() => new Promise((resolve) => setTimeout(resolve, 1_300)));

      expect(screen.getByDisplayValue('Альфа Прайм')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
