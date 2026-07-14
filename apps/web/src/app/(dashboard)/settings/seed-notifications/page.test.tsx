// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
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
});
