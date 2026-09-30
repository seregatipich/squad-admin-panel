// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BonusSection } from './BonusSection';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const PLAYER_ID = 'b1e2c3d4-0000-0000-0000-000000000002';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BonusSection — race between loadMore() and a filter-driven load() (#433)', () => {
  it('ignores a stale loadMore() response that resolves after a newer filter load()', async () => {
    const firstPage = {
      items: [
        {
          id: 1,
          player_id: PLAYER_ID,
          amount: 100,
          type: 'admin_grant',
          reference_type: null,
          reference_id: null,
          comment: 'initial comment',
          actor_player_id: null,
          created_at: '2026-07-01T10:00:00.000Z',
        },
      ],
      next_cursor: 1,
    };
    const filteredPage = {
      items: [
        {
          id: 2,
          player_id: PLAYER_ID,
          amount: -50,
          type: 'admin_deduct',
          reference_type: null,
          reference_id: null,
          comment: 'filtered comment',
          actor_player_id: null,
          created_at: '2026-07-01T11:00:00.000Z',
        },
      ],
      next_cursor: null,
    };

    let listCalls = 0;
    const staleLoadMore = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/bonus-balance')) {
        return Promise.resolve(new Response(JSON.stringify({ balance: 100 }), { status: 200 }));
      }
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ can_manage_economy: false, permissions: [] }), {
            status: 200,
          }),
        );
      }
      if (url.includes('/bonus-transactions')) {
        listCalls += 1;
        if (listCalls === 1) {
          return Promise.resolve(new Response(JSON.stringify(firstPage), { status: 200 }));
        }
        if (listCalls === 2) {
          // loadMore(): held back deliberately to simulate it resolving late.
          return staleLoadMore.promise;
        }
        return Promise.resolve(new Response(JSON.stringify(filteredPage), { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<BonusSection playerId={PLAYER_ID} canManage canAssign />);
    await screen.findByText('initial comment');

    fireEvent.click(screen.getByRole('button', { name: /показать ещё/i }));
    await vi.waitFor(() => expect(listCalls).toBe(2));

    // Apply a new filter while loadMore() is still in flight.
    fireEvent.click(screen.getByRole('button', { name: /применить/i }));
    await screen.findByText('filtered comment');
    expect(screen.queryByText('initial comment')).not.toBeInTheDocument();

    // Now the stale loadMore() response finally arrives.
    staleLoadMore.resolve(
      new Response(
        JSON.stringify({ items: [{ ...firstPage.items[0], id: 99 }], next_cursor: null }),
        { status: 200 },
      ),
    );
    await new Promise((r) => setTimeout(r, 20));

    // It must not have clobbered the newer filter's result.
    expect(screen.queryByText('initial comment')).not.toBeInTheDocument();
    expect(screen.getByText('filtered comment')).toBeInTheDocument();
  });
});
