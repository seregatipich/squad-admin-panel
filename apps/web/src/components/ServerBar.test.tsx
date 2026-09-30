// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';

const mockUsePathname = vi.fn(() => '/dashboard');
vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));
type LiveHandler = (event: { type: string; ts: string; data: Record<string, unknown> }) => void;
const liveHandlers = new Map<string, LiveHandler>();
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: vi.fn((type: string, handler: LiveHandler) => {
    liveHandlers.set(type, handler);
  }),
}));

function emit(type: string, data: Record<string, unknown>) {
  act(() => {
    liveHandlers.get(type)?.({ type, ts: new Date().toISOString(), data });
  });
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { ServerBar } from './ServerBar';

const SERVERS = [
  { id: 'a1', display_name: 'Main #1', status: 'running', player_count: 78 },
  { id: 'b2', display_name: 'Seed #2', status: 'stopped', player_count: null },
];

function respondWith(items: unknown[]) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ items }), { status: 200 }));
}

function renderBar() {
  return render(
    <LocaleProvider>
      <ServerBar />
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  mockUsePathname.mockReturnValue('/dashboard');
  fetchMock.mockReset();
  liveHandlers.clear();
});

describe('ServerBar', () => {
  it('renders one chip per server, linking to its page', async () => {
    respondWith(SERVERS);
    renderBar();

    const chip = await screen.findByRole('link', { name: /Main #1/ });
    expect(chip).toHaveAttribute('href', '/servers/a1');
    expect(chip).toHaveTextContent('78');
    expect(screen.getByRole('link', { name: /Seed #2/ })).toHaveAttribute('href', '/servers/b2');
  });

  it('shows no number for a server the poller has never reached', async () => {
    respondWith(SERVERS);
    renderBar();

    const chip = await screen.findByRole('link', { name: /Seed #2/ });
    // A never-polled server must not read as "0 players online".
    expect(chip).not.toHaveTextContent('0');
  });

  it('marks the server whose page is open as the current one', async () => {
    mockUsePathname.mockReturnValue('/servers/b2/monitoring');
    respondWith(SERVERS);
    renderBar();

    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Seed #2/ })).toHaveAttribute('aria-current', 'page'),
    );
    expect(screen.getByRole('link', { name: /Main #1/ })).not.toHaveAttribute('aria-current');
  });

  it('offers the create-server link alongside the chips', async () => {
    respondWith(SERVERS);
    renderBar();
    expect(await screen.findByRole('link', { name: /Сервер/ })).toBeInTheDocument();
  });

  it('renders nothing at all on a page where no server is the subject', () => {
    mockUsePathname.mockReturnValue('/settings/account');
    respondWith(SERVERS);
    const { container } = renderBar();
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders nothing while the panel has no servers', async () => {
    respondWith([]);
    const { container } = renderBar();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('stays silent when the servers request fails', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    const { container } = renderBar();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('публикует высоту всей прилипающей хромы, пока полоса на экране', async () => {
    respondWith(SERVERS);
    renderBar();
    await screen.findByRole('link', { name: /Main #1/ });

    // Липкие шапки таблиц отсчитываются от этой переменной; без неё они
    // уехали бы под полосу серверов.
    expect(document.documentElement.style.getPropertyValue('--chrome-h')).toContain('var(--nav-h)');
  });

  it('снимает переменную, когда полоса не показывается', async () => {
    respondWith(SERVERS);
    mockUsePathname.mockReturnValue('/settings/account');
    const { unmount } = renderBar();
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--chrome-h')).toBe(''),
    );
    unmount();
  });

  // #791: the bar sits in the shared layout, so its live handlers run on every
  // page and every rcon.status tick used to refetch the whole server list.
  it('patches the player count from rcon.status without refetching', async () => {
    respondWith(SERVERS);
    renderBar();
    await screen.findByRole('link', { name: /Main #1/ });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    emit('rcon.status', { server_id: 'a1', state: 'connected', player_count: 91 });

    expect(screen.getByRole('link', { name: /Main #1/ })).toHaveTextContent('91');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores live events on pages where the bar is hidden', async () => {
    mockUsePathname.mockReturnValue('/settings/account');
    respondWith(SERVERS);
    renderBar();

    emit('server.status', { server_id: 'a1', status: 'stopped', source: 'reconciler' });
    emit('rcon.status', { server_id: 'a1', state: 'connected', player_count: 5 });

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('coalesces a burst of status events into one refetch', async () => {
    respondWith(SERVERS);
    renderBar();
    await screen.findByRole('link', { name: /Main #1/ });

    for (let i = 0; i < 5; i += 1) {
      emit('server.status', { server_id: 'a1', status: 'running', source: 'reconciler' });
    }

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never lets an older response overwrite a newer one', async () => {
    respondWith(SERVERS);
    renderBar();
    await screen.findByRole('link', { name: /Main #1/ });

    const pending: Array<(items: unknown[]) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          pending.push((items) =>
            resolve(new Response(JSON.stringify({ items }), { status: 200 })),
          );
        }),
    );
    emit('server.deleted', { server_id: 'b2', deleted_at: '', by: null });
    await waitFor(() => expect(pending).toHaveLength(1), { timeout: 2000 });
    emit('server.status', { server_id: 'a1', status: 'stopped', source: 'reconciler' });
    await waitFor(() => expect(pending).toHaveLength(2), { timeout: 2000 });

    const newest = [{ id: 'a1', display_name: 'Main #1', status: 'stopped', player_count: 0 }];
    await act(async () => {
      pending[1]?.(newest);
      await new Promise((resolve) => setTimeout(resolve, 20));
      pending[0]?.(SERVERS);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByRole('link', { name: /Seed #2/ })).toBeNull();
  });
});
