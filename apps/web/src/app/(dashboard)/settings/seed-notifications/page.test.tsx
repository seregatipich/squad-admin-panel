// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SeedNotificationsPage from './page';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SeedNotificationsPage', () => {
  it('loads servers and toggles a per-server channel subscription', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({ enabled: true }), { status: 200 }));
      }
      if (url.endsWith('/servers')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ id: 'server-1', display_name: 'RU #1', status: 'running' }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ subscriptions: [] }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SeedNotificationsPage />);
    expect(await screen.findByText('RU #1')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: 'Web Push' });
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/servers/server-1/seed-subscription',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
    expect(checkbox).toBeChecked();
  });

  it('removes an existing subscription when its checkbox is cleared', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toMatchObject({ channel: 'webpush', enabled: false });
        return Promise.resolve(new Response(JSON.stringify({ enabled: false }), { status: 200 }));
      }
      if (url.endsWith('/servers')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ id: 'server-1', display_name: 'RU #1', status: 'running' }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            subscriptions: [{ server_id: 'server-1', server_name: 'RU #1', channel: 'webpush' }],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SeedNotificationsPage />);
    const checkbox = await screen.findByRole('checkbox', { name: 'Web Push' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
  });

  it('shows an empty-server state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ subscriptions: [] }), { status: 200 }),
        );
      }),
    );
    render(<SeedNotificationsPage />);
    expect(await screen.findByText('Серверов пока нет')).toBeInTheDocument();
  });

  it('shows a toggle error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return Promise.resolve(new Response(JSON.stringify({ error: 'down' }), { status: 503 }));
        }
        if (url.endsWith('/servers')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [{ id: 'server-1', display_name: 'RU #1', status: 'running' }],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ subscriptions: [] }), { status: 200 }),
        );
      }),
    );
    render(<SeedNotificationsPage />);
    const checkbox = await screen.findByRole('checkbox', { name: 'Web Push' });
    fireEvent.click(checkbox);
    expect(await screen.findByText('HTTP 503')).toBeInTheDocument();
  });

  it('shows a load error when the server list cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'down' }), {
            status: url.endsWith('/servers') ? 503 : 200,
          }),
        ),
      ),
    );
    render(<SeedNotificationsPage />);
    expect(await screen.findByText('HTTP 503')).toBeInTheDocument();
  });

  it('shows a load error when subscriptions cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/servers')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [{ id: 'server-1', display_name: 'RU #1', status: 'running' }],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ error: 'down' }), { status: 503 }));
      }),
    );
    render(<SeedNotificationsPage />);
    expect(await screen.findByText('HTTP 503')).toBeInTheDocument();
  });
});
