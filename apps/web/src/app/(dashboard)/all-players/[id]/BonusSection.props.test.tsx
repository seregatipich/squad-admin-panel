// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BonusSection } from './BonusSection';
import type { BonusTransaction } from './bonus-history';

function tx(id: number, overrides: Partial<BonusTransaction> = {}): BonusTransaction {
  return {
    id,
    player_id: 'player-1',
    amount: 10,
    type: 'earn_online',
    reference_type: 'daily_presence',
    reference_id: '2026-07-01',
    comment: null,
    actor_player_id: null,
    created_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init)),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BonusSection', () => {
  it('never fetches /api/v1/me itself, taking canManage/canAssign from props (#435)', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes('/bonus-balance'))
        return new Response(JSON.stringify({ balance: 100 }), { status: 200 });
      if (url.includes('/bonus-transactions'))
        return new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });

    render(<BonusSection playerId="player-1" canManage canAssign />);

    await waitFor(() => expect(screen.getByText('Корректировать баланс')).toBeInTheDocument());
    expect(screen.getByText('Купить привилегию')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/v1/me')).toBe(false);
  });

  it('hides the manage/assign actions when the props say no', async () => {
    stubFetch((url) => {
      if (url.includes('/bonus-balance'))
        return new Response(JSON.stringify({ balance: 0 }), { status: 200 });
      if (url.includes('/bonus-transactions'))
        return new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });

    render(<BonusSection playerId="player-1" canManage={false} canAssign={false} />);

    await screen.findByText('Бонусы');
    expect(screen.queryByText('Корректировать баланс')).not.toBeInTheDocument();
    expect(screen.queryByText('Купить привилегию')).not.toBeInTheDocument();
  });

  it('splices in an adjustment that matches the applied filter (#437)', async () => {
    stubFetch((url, init) => {
      if (url.includes('/bonus-balance'))
        return new Response(JSON.stringify({ balance: 100 }), { status: 200 });
      if (url.includes('/bonus-adjustments')) {
        return new Response(
          JSON.stringify({
            player_id: 'player-1',
            balance: 90,
            transaction: tx(99, { type: 'adjust', amount: -10 }),
          }),
          { status: 200 },
        );
      }
      if (url.includes('/bonus-transactions')) {
        return new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? ''}`);
    });

    render(<BonusSection playerId="player-1" canManage canAssign />);
    await waitFor(() => expect(screen.getByText('Корректировать баланс')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Корректировать баланс'));
    fireEvent.change(screen.getByPlaceholderText('например, -50'), { target: { value: '-10' } });
    fireEvent.change(screen.getByPlaceholderText('причина корректировки'), {
      target: { value: 'test' },
    });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Применить' }));

    await waitFor(() => expect(screen.getByText('90')).toBeInTheDocument());
    expect(within(screen.getByRole('table')).getByText('Корректировка')).toBeInTheDocument();
  });

  it('does not splice in an adjustment that the applied type filter would exclude (#437)', async () => {
    stubFetch((url) => {
      if (url.includes('/bonus-balance'))
        return new Response(JSON.stringify({ balance: 100 }), { status: 200 });
      if (url.includes('/bonus-adjustments')) {
        return new Response(
          JSON.stringify({
            player_id: 'player-1',
            balance: 90,
            transaction: tx(99, { type: 'adjust', amount: -10 }),
          }),
          { status: 200 },
        );
      }
      if (url.includes('/bonus-transactions')) {
        return new Response(
          JSON.stringify({ items: [tx(1, { type: 'earn_online' })], next_cursor: null }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    render(<BonusSection playerId="player-1" canManage canAssign />);
    // The filter narrows the table to "Онлайн" transactions only, excluding
    // the "adjust" row the modal is about to create.
    fireEvent.change(await screen.findByLabelText(/Тип/), { target: { value: 'earn_online' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await screen.findByText('Онлайн');

    fireEvent.click(screen.getByText('Корректировать баланс'));
    fireEvent.change(screen.getByPlaceholderText('например, -50'), { target: { value: '-10' } });
    fireEvent.change(screen.getByPlaceholderText('причина корректировки'), {
      target: { value: 'test' },
    });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Применить' }));

    await waitFor(() => expect(screen.getByText('90')).toBeInTheDocument());
    expect(within(screen.getByRole('table')).queryByText('Корректировка')).not.toBeInTheDocument();
  });
});
