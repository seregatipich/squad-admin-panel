// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminsCfgDriftBanner } from './AdminsCfgDriftBanner';

type Status = Record<string, unknown>;

/** Answers the drift poll with `status` and records every sync POST. */
function stubApi(status: Status) {
  const calls: string[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    if (url.includes('/drift')) {
      return Promise.resolve(
        new Response(JSON.stringify({ server_id: 's1', status }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const HOUR_MS = 60 * 60_000;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdminsCfgDriftBanner', () => {
  it('renders nothing while the file is in sync', async () => {
    stubApi({
      state: 'in_sync',
      last_synced_at: null,
      last_segment_hash: null,
      last_db_hash: null,
    });
    const { container } = render(<AdminsCfgDriftBanner serverId="s1" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('stays quiet through a short bridge outage', async () => {
    // A bridge restart resolves itself well inside the debounce window; a
    // banner there would flicker on every routine restart.
    stubApi({
      state: 'unreachable',
      last_synced_at: null,
      last_segment_hash: null,
      last_db_hash: null,
      unreachable_since: new Date(Date.now() - 5_000).toISOString(),
    });
    const { container } = render(<AdminsCfgDriftBanner serverId="s1" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('announces a sustained outage as an alert and offers a retry', async () => {
    stubApi({
      state: 'unreachable',
      last_synced_at: null,
      last_segment_hash: null,
      last_db_hash: null,
      unreachable_since: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      error: 'bridge timeout',
    });
    render(<AdminsCfgDriftBanner serverId="s1" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Admins.cfg уже 3 часов');
    expect(alert).toHaveTextContent('bridge timeout');
    expect(screen.getByRole('button', { name: 'Повторить синхронизацию' })).toBeInTheDocument();
  });

  it('reports drift in Russian and syncs on demand', async () => {
    const calls = stubApi({
      state: 'drift',
      last_synced_at: null,
      last_segment_hash: 'aaa',
      last_db_hash: 'bbb',
    });
    render(<AdminsCfgDriftBanner serverId="s1" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('изменён вне панели');

    fireEvent.click(screen.getByRole('button', { name: 'Синхронизировать' }));

    await waitFor(() => expect(calls).toContain('POST /api/v1/admins-cfg/sync'));
  });
});
