// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ComparePlayerOnlinePage from './page';

const PLAYER_A = 'a1e2c3d4-0000-0000-0000-00000000000a';
const PLAYER_B = 'b1e2c3d4-0000-0000-0000-00000000000b';

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
                { id: PLAYER_A, canonical_name: 'PlayerA', steam_id64: null },
                { id: PLAYER_B, canonical_name: 'PlayerB', steam_id64: null },
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

async function renderPage(other?: string, id: string = PLAYER_A) {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <ComparePlayerOnlinePage
          params={Promise.resolve({ id })}
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
      `/all-players/${PLAYER_A}`,
    );
  });

  it('passes route params through and fetches compare-online when ?other= is present', async () => {
    await renderPage(PLAYER_B);
    await screen.findAllByText('PlayerB');
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const compareCall = calls.find((call) => String(call[0]).includes('/compare-online'));
    expect(compareCall?.[0]).toContain(`/api/v1/players/${PLAYER_A}/compare-online`);
    expect(compareCall?.[0]).toContain(`other=${PLAYER_B}`);
  });

  // Regression (#472): the decoded route ids went into the compare request unchecked.
  it('refuses route ids that are not UUIDs without calling the API', async () => {
    await renderPage(PLAYER_B, '..%2F..%2Fadmin');
    expect(screen.getByText('Некорректный идентификатор игрока')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a malformed ?other= instead of sending it to the API', async () => {
    await renderPage('../../x');
    expect(screen.getByText('Второй игрок не выбран')).toBeInTheDocument();
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((call) => String(call[0]).includes('/compare-online'))).toBe(false);
  });
});
