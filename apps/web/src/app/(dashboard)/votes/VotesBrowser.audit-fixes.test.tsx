// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const liveHandlers: Array<() => void> = [];
const stableSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/votes',
  useSearchParams: () => stableSearchParams,
}));
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (_kind: string, handler: () => void) => {
    liveHandlers.push(handler);
  },
}));

import { VotesBrowser } from './VotesBrowser';

interface MockOptions {
  listStatus?: number;
  countStatus?: number;
  totals?: number[];
}

/** Serves votes list, count and servers; `totals` is consumed one count call at a time. */
function mockFetch(opts: MockOptions = {}) {
  const totals = [...(opts.totals ?? [7])];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/v1/votes/count')) {
        const status = opts.countStatus ?? 200;
        return Promise.resolve(
          new Response(JSON.stringify({ total: totals.shift() ?? 0 }), { status }),
        );
      }
      if (url.startsWith('/api/v1/votes?')) {
        const status = opts.listStatus ?? 200;
        return Promise.resolve(
          new Response(JSON.stringify({ items: [], next_cursor: null }), { status }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  liveHandlers.length = 0;
});

describe('VotesBrowser', () => {
  it('shows a Russian message for a failed list request, never a raw HTTP code', async () => {
    mockFetch({ listStatus: 500 });
    render(<VotesBrowser />);

    expect(await screen.findByText('Сервер вернул ошибку (код 500).')).toBeInTheDocument();
    expect(screen.queryByText('HTTP 500')).not.toBeInTheDocument();
  });

  it('does not claim "всего: 0" when the count request fails', async () => {
    mockFetch({ countStatus: 500 });
    render(<VotesBrowser />);

    await screen.findByText('Голосования');
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/votes/count'),
        expect.anything(),
      ),
    );
    expect(screen.queryByText('всего: 0')).not.toBeInTheDocument();
    expect(screen.getByText('всего: …')).toBeInTheDocument();
  });

  it('refreshes the total when a vote ends', async () => {
    mockFetch({ totals: [7, 8] });
    render(<VotesBrowser />);
    expect(await screen.findByText('всего: 7')).toBeInTheDocument();

    liveHandlers.at(-1)?.();

    expect(await screen.findByText('всего: 8')).toBeInTheDocument();
  });
});
