// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatCooldown, SeedCallButton } from './SeedCallButton';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('formatCooldown', () => {
  it('formats seconds as minutes and seconds', () => {
    expect(formatCooldown(125)).toBe('2:05');
  });
});

describe('SeedCallButton', () => {
  it('hides the button without chat or manageserver permission', () => {
    render(<SeedCallButton serverId="server-1" canCall={false} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('posts a manual seed call and starts the cooldown', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ retry_after: 7200 }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ available: true, retry_after: 0, join_link: null }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SeedCallButton serverId="server-1" canCall />);
    const button = await screen.findByRole('button', { name: 'Позвать сидеров' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Сидеры уведомлены')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/servers/server-1/seed-call',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByRole('button', { name: /Повторить через 120:00/ })).toBeDisabled();
  });

  it('shows a Russian message for a known error code instead of the raw code', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'host_unavailable' }), { status: 502 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ available: true, retry_after: 0, join_link: null }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SeedCallButton serverId="server-1" canCall />);
    fireEvent.click(await screen.findByRole('button', { name: 'Позвать сидеров' }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Хост сервера недоступен');
    expect(banner).not.toHaveTextContent('host_unavailable');
  });

  it('does not leave the button stuck on a malformed GET status response', async () => {
    // retry_after is a string instead of a number: without validation this
    // would previously flow straight into setRemaining and break the timer.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ available: false, retry_after: 'soon', join_link: null }), {
            status: 200,
          }),
        ),
      ),
    );

    render(<SeedCallButton serverId="server-1" canCall />);
    const button = await screen.findByRole('button', { name: 'Позвать сидеров' });
    expect(button).toBeEnabled();
  });

  it('does not reject unhandled when the GET status request fails', async () => {
    const onUnhandledRejection = vi.fn();
    process.on('unhandledRejection', onUnhandledRejection);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );

    render(<SeedCallButton serverId="server-1" canCall />);
    await screen.findByRole('button', { name: 'Позвать сидеров' });
    // Flush the microtask queue so a rejection (if any) would have surfaced.
    await Promise.resolve();
    await Promise.resolve();

    expect(onUnhandledRejection).not.toHaveBeenCalled();
    process.off('unhandledRejection', onUnhandledRejection);
  });
});
