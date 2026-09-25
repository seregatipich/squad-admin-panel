// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const stableSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn() })),
  usePathname: vi.fn(() => '/chat'),
  useSearchParams: vi.fn(() => stableSearchParams),
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: vi.fn() }));

import { ChatArchive } from './ChatArchive';

const MESSAGES_RESPONSE = {
  items: [
    {
      id: 1,
      serverId: 'srv-1',
      scope: 'all',
      message: 'hello everyone',
      source: 'chat',
      isFlagged: false,
      teamId: null,
      squadId: null,
      sentAt: '2026-04-23T11:30:20.485Z',
      player: { id: 'player-1', nickname: 'Alpha' },
    },
  ],
  next_cursor: null,
};

function mockFetch(opts: { canBan: boolean }) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/chat/messages')) {
      return Promise.resolve(new Response(JSON.stringify(MESSAGES_RESPONSE), { status: 200 }));
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    if (url === '/api/v1/me') {
      return Promise.resolve(
        new Response(JSON.stringify({ squad_permissions: opts.canBan ? ['ban'] : [] }), {
          status: 200,
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatArchive — BANNAME-3 ban button gating + prefill', () => {
  it('hides the «Забанить ник» button without the ban squad permission', async () => {
    vi.stubGlobal('fetch', mockFetch({ canBan: false }));
    render(<ChatArchive />);
    await screen.findByText('Alpha');
    expect(screen.queryByRole('button', { name: /забанить ник/i })).not.toBeInTheDocument();
  });

  it('shows a «Забанить ник» button with the ban squad permission, prefilling the modal with the row nickname', async () => {
    vi.stubGlobal('fetch', mockFetch({ canBan: true }));
    render(<ChatArchive />);
    const button = await screen.findByRole('button', { name: /забанить ник/i });
    fireEvent.click(button);
    const patternInput = (await screen.findByLabelText(/паттерн/i)) as HTMLInputElement;
    expect(patternInput.value).toBe('Alpha');
  });
});
