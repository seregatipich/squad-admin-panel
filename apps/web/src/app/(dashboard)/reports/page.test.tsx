// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/reports'),
  useRouter: vi.fn(() => ({ replace })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: () => undefined }));
vi.mock('./ReportsAnalytics', () => ({
  ReportsAnalytics: () => <p>аналитика жалоб</p>,
}));

import ReportsPage from './page';

const REPORT = {
  id: 'report-1',
  server_id: 'server-1',
  reporter_player_id: 'reporter-1',
  target_player_id: 'b1e2c3d4-0000-0000-0000-000000000001',
  target_raw: null,
  body: 'Стреляет через стены',
  source: 'ui' as const,
  status: 'pending' as const,
  handler_player_id: null,
  resolution_note: null,
  created_at: '2026-07-01T00:00:00.000Z',
  claimed_at: null,
  resolved_at: null,
  server_name: 'Test server',
  server_slug: 'test-server',
  reporter_name: 'Жалобщик',
  target_name: 'Нарушитель',
  handler_name: null,
  evidence: [],
  evidence_count: 0,
  reporter_trusted: false,
  reporter_spam_flagged: false,
  target_report_count_90d: 0,
};

function stubFetch(opts: { items?: unknown[]; listStatus?: number; canHandle?: boolean } = {}) {
  const urls: string[] = [];
  const items = opts.items ?? [REPORT];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ can_handle_reports: opts.canHandle ?? true })),
        );
      }
      if (url.startsWith('/api/v1/reports?')) {
        return Promise.resolve(
          new Response(JSON.stringify({ items, total: items.length }), {
            status: opts.listStatus ?? 200,
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return urls;
}

afterEach(() => {
  cleanup();
  replace.mockClear();
  vi.unstubAllGlobals();
});

describe('ReportsPage', () => {
  it('shows the loading skeleton until the reports arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<ReportsPage />);

    expect(await screen.findByText('Загрузка жалоб')).toBeInTheDocument();
  });

  it('renders the report card with both players and the complaint text', async () => {
    const urls = stubFetch();
    render(<ReportsPage />);

    expect(await screen.findByText('Стреляет через стены')).toBeInTheDocument();
    expect(screen.getByText('Жалобщик')).toBeInTheDocument();
    expect(screen.getByText('Нарушитель')).toBeInTheDocument();
    expect(screen.getByText('Найдено: 1')).toBeInTheDocument();
    expect(urls.some((url) => url.startsWith('/api/v1/reports?'))).toBe(true);
  });

  it('offers warn, kick and ban only to a moderator who can handle reports', async () => {
    stubFetch({ canHandle: true });
    render(<ReportsPage />);

    expect(await screen.findByRole('button', { name: 'Забанить' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Предупредить' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Кикнуть' })).toBeInTheDocument();
  });

  it('hides the enforcement actions from a viewer without the handle permission', async () => {
    stubFetch({ canHandle: false });
    render(<ReportsPage />);

    await screen.findByText('Стреляет через стены');
    expect(screen.queryByRole('button', { name: 'Забанить' })).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no reports', async () => {
    stubFetch({ items: [] });
    render(<ReportsPage />);

    expect(await screen.findByText('Жалоб нет')).toBeInTheDocument();
    expect(screen.getByText('Найдено: 0')).toBeInTheDocument();
  });

  it('shows an error banner when the list request fails', async () => {
    stubFetch({ listStatus: 500 });
    render(<ReportsPage />);

    expect(await screen.findByText('Не удалось загрузить жалобы')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
  });

  it('puts the chosen status filter into the URL', async () => {
    stubFetch();
    render(<ReportsPage />);
    await screen.findByText('Стреляет через стены');

    await userEvent.click(screen.getByRole('tab', { name: 'Ожидают' }));

    expect(replace).toHaveBeenCalledWith('/reports?status=pending');
  });

  it('switches to the analytics view', async () => {
    stubFetch();
    render(<ReportsPage />);
    await screen.findByText('Стреляет через стены');

    await userEvent.click(screen.getByRole('tab', { name: 'Аналитика' }));

    expect(screen.getByText('аналитика жалоб')).toBeInTheDocument();
    expect(screen.queryByText('Стреляет через стены')).not.toBeInTheDocument();
  });
});
