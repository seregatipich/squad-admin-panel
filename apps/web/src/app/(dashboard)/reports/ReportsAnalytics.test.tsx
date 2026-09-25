// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportAnalytics } from './analytics-data';
import { ReportsAnalytics } from './ReportsAnalytics';

const FIXTURE: ReportAnalytics = {
  server_id: null,
  from: '2026-06-01T00:00:00.000Z',
  to: '2026-07-01T00:00:00.000Z',
  summary: {
    total: 12,
    by_status: { pending: 2, in_review: 1, resolved: 7, rejected: 2 },
    avg_resolution_seconds: 3600,
    median_resolution_seconds: 1800,
  },
  trend: [
    { day: '2026-06-28', count: 3 },
    { day: '2026-06-29', count: 5 },
  ],
  by_server: [{ server_id: 'srv-1', server_name: 'Server 1', total: 12, resolved: 7, rejected: 2 }],
  by_handler: [
    {
      player_id: 'handler-1',
      name: 'ModOne',
      handled: 9,
      resolved: 7,
      rejected: 2,
      avg_resolution_seconds: 3600,
    },
  ],
  top_targets: [
    { player_id: 'target-1', name: 'CheaterGuy', count_30d: 2, count_90d: 4 },
    { player_id: 'target-2', name: 'MinorOffender', count_30d: 1, count_90d: 1 },
  ],
  top_reporters: [
    {
      player_id: 'reporter-1',
      name: 'TrustedReporter',
      total: 10,
      resolved: 9,
      rejected: 1,
      confirmed: 6,
      accuracy: 0.6667,
      trusted: true,
      spam_flagged: false,
    },
    {
      player_id: 'reporter-2',
      name: 'SpamReporter',
      total: 6,
      resolved: 0,
      rejected: 6,
      confirmed: 0,
      accuracy: 0,
      trusted: false,
      spam_flagged: true,
    },
  ],
};

function mockFetch(status: number, body: unknown) {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReportsAnalytics', () => {
  it('renders stat tiles, trust badges, and the recidivist highlight from a fixture payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify(FIXTURE), { status: 200 }));
      }),
    );

    render(<ReportsAnalytics />);

    await waitFor(() => expect(screen.getByText('12')).toBeInTheDocument());

    expect(screen.getByText('Доверенный')).toBeInTheDocument();
    expect(screen.getByText('Спам')).toBeInTheDocument();
    expect(screen.getByText('4 жалобы за 90 дн')).toBeInTheDocument();
    // The non-recidivist target renders its raw count, not the badge.
    expect(screen.getByText('MinorOffender')).toBeInTheDocument();
  });

  it('names the SLA chart after moderators, because only they carry a resolution time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify(FIXTURE), { status: 200 }));
      }),
    );

    render(<ReportsAnalytics />);

    await waitFor(() =>
      expect(screen.getByText('Среднее время решения по модераторам (SLA)')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/по серверам/)).not.toBeInTheDocument();
  });

  it('still draws the SLA chart when no server has reports but a moderator has resolved some', async () => {
    // The chart used to be gated on `by_server`, which carries no
    // `avg_resolution_seconds` at all — so this payload hid a chart that had
    // every number it needed.
    const handlersOnly: ReportAnalytics = { ...FIXTURE, by_server: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/v1/servers')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify(handlersOnly), { status: 200 }));
      }),
    );

    render(<ReportsAnalytics />);

    await waitFor(() =>
      expect(screen.getByText('Среднее время решения по модераторам (SLA)')).toBeInTheDocument(),
    );
  });

  it('renders nothing when the analytics endpoint responds 403', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { error: 'forbidden' }));

    const { container } = render(<ReportsAnalytics />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
