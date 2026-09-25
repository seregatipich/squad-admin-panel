// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';

const mockUsePathname = vi.fn(() => '/dashboard');
vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: vi.fn(),
}));

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
    <LocaleProvider locale="ru">
      <ServerBar />
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  mockUsePathname.mockReturnValue('/dashboard');
  fetchMock.mockReset();
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
});
