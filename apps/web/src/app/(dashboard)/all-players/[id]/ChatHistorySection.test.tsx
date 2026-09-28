// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLiveSubscription } from '@/lib/use-live-bus';
import { ChatHistorySection } from './ChatHistorySection';

vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

const EMPTY_PAGE = { items: [], next_cursor: null };

function stubFetch() {
  const calls: string[] = [];
  const mock = vi.fn((url: string) => {
    calls.push(String(url));
    if (String(url).includes('/count')) {
      return Promise.resolve(new Response(JSON.stringify({ count: 7 }), { status: 200 }));
    }
    if (String(url) === '/api/v1/servers') {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(EMPTY_PAGE), { status: 200 }));
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatHistorySection', () => {
  it('fetches the 30-day count once per player, not on every apply/reset (#436)', async () => {
    vi.mocked(useLiveSubscription).mockImplementation(() => {});
    const { calls } = stubFetch();

    render(<ChatHistorySection playerId="player-1" />);
    await waitFor(() => expect(screen.getByText('7 / 30д')).toBeInTheDocument());

    const countCallsAfterMount = calls.filter((url) => url.includes('/count')).length;
    expect(countCallsAfterMount).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(calls.filter((url) => url.includes('/messages?')).length).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    await waitFor(() => expect(calls.filter((url) => url.includes('/messages?')).length).toBe(3));

    // The list refetched on Apply and Reset, but the count endpoint stayed
    // at its single mount-time call.
    expect(calls.filter((url) => url.includes('/count')).length).toBe(1);
  });
});
