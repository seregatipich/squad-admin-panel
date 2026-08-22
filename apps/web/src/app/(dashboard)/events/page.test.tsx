// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/events'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import EventsPage from './page';

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/events/count')) {
      return Promise.resolve(new Response(JSON.stringify({ total: 0 }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/events')) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], next_cursor: null, limit: 50 }), { status: 200 }),
      );
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EventsPage', () => {
  it('is a valid React component', () => {
    expect(EventsPage).toBeDefined();
    expect(typeof EventsPage).toBe('function');
  });

  it('даёт странице ровно один заголовок первого уровня', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsPage />);
    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Журнал событий');
  });
});
