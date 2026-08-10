// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import ServersPage from './page';

function makeServer(overrides: { id: string; display_name: string; tags: string[] }) {
  return {
    slug: overrides.display_name.toLowerCase().replace(/\s+/g, '-'),
    status: 'running',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    rcon_state: null,
    player_count: null,
    last_poll_at: null,
    seeding: null,
    ...overrides,
  };
}

function mockServersFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/v1/servers') {
        const items = [
          makeServer({ id: 'srv-1', display_name: 'EU Main', tags: ['eu'] }),
          makeServer({ id: 'srv-2', display_name: 'NA Main', tags: ['na'] }),
        ];
        return Promise.resolve(
          new Response(JSON.stringify({ items, total: items.length }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ServersPage', () => {
  it('is a valid React component', () => {
    expect(ServersPage).toBeDefined();
    expect(typeof ServersPage).toBe('function');
  });

  it('tag filter narrows the server list', async () => {
    mockServersFetch();
    await act(async () => {
      render(<ServersPage />);
    });
    // Both servers listed before a tag is picked.
    expect(await screen.findByText('EU Main')).toBeInTheDocument();
    expect(screen.getByText('NA Main')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'eu' } });

    expect(screen.getByText('EU Main')).toBeInTheDocument();
    expect(screen.queryByText('NA Main')).not.toBeInTheDocument();

    // Back to «Все теги» restores the full list.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(screen.getByText('NA Main')).toBeInTheDocument();
  });
});
