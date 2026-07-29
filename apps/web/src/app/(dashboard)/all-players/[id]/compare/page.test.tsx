// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ComparePlayerOnlinePage from './page';

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/compare-online')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              window: { from: '2026-07-01', to: '2026-07-07' },
              players: [
                { id: 'player-a', canonical_name: 'PlayerA', steam_id64: null },
                { id: 'player-b', canonical_name: 'PlayerB', steam_id64: null },
              ],
              sessions: { a: [], b: [] },
              overlap: { total_seconds: 0, concurrent_count: 0, intervals: [] },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

beforeEach(() => {
  mockFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage(other?: string) {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <ComparePlayerOnlinePage
          params={Promise.resolve({ id: 'player-a' })}
          searchParams={Promise.resolve({ other })}
        />
      </Suspense>,
    );
  });
}

describe('ComparePlayerOnlinePage', () => {
  it('is a valid React component', () => {
    expect(ComparePlayerOnlinePage).toBeDefined();
    expect(typeof ComparePlayerOnlinePage).toBe('function');
  });

  it('renders the heading and a back link to the player card', async () => {
    await renderPage();
    expect(
      screen.getByRole('heading', { name: 'Сравнение онлайна', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /К игроку/ })).toHaveAttribute(
      'href',
      '/all-players/player-a',
    );
  });

  it('passes route params through and fetches compare-online when ?other= is present', async () => {
    await renderPage('player-b');
    await screen.findAllByText('PlayerB');
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const compareCall = calls.find((call) => String(call[0]).includes('/compare-online'));
    expect(compareCall?.[0]).toContain('/api/v1/players/player-a/compare-online');
    expect(compareCall?.[0]).toContain('other=player-b');
  });
});
