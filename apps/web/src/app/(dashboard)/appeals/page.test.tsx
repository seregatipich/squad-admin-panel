// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/appeals'),
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: () => undefined,
}));

import AppealsPage from './page';

const PENDING_APPEAL = {
  id: 'appeal-1',
  number: 7,
  status: 'pending' as const,
  steam_id64: '76561198000987100',
  body: 'Меня забанили по ошибке, прошу пересмотреть.',
  contact: 'discord: appellant#1',
  decision_note: null,
  internal_note: null,
  created_at: '2026-07-20T10:00:00.000Z',
  updated_at: '2026-07-20T10:00:00.000Z',
  decided_at: null,
  player: { id: 'player-1', name: 'Appellant', steam_id64: '76561198000987100' },
  moderation_action: {
    id: 'action-1',
    action_type: 'ban',
    reason: 'aimbot',
    created_at: '2026-07-19T10:00:00.000Z',
    ban_length: '0',
  },
  handler: null,
};

interface Call {
  url: string;
  init?: RequestInit;
}

function stubFetch(opts: { items?: unknown[]; listStatus?: number } = {}): Call[] {
  const items = opts.items ?? [PENDING_APPEAL];
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.method === 'PATCH') {
        return Promise.resolve(
          new Response(
            JSON.stringify({ appeal: { ...PENDING_APPEAL, status: 'approved' }, revert: null }),
          ),
        );
      }
      if (opts.listStatus && opts.listStatus !== 200) {
        return Promise.resolve(new Response('{}', { status: opts.listStatus }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ items, total: items.length, page: 1, page_size: 20 })),
      );
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppealsPage', () => {
  it('shows the loading skeleton until the queue arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<AppealsPage />);

    expect(await screen.findByText('Загрузка апелляций')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Апелляции' })).toBeInTheDocument();
  });

  it('lists the pending appeal with its number and the appealed ban reason', async () => {
    stubFetch();
    render(<AppealsPage />);

    expect(await screen.findByText('#7')).toBeInTheDocument();
    expect(screen.getByText(/Меня забанили по ошибке/)).toBeInTheDocument();
    expect(screen.getByText(/aimbot/)).toBeInTheDocument();
    expect(screen.getByText('Всего: 1')).toBeInTheDocument();
  });

  it('shows the empty state when no appeals were filed', async () => {
    stubFetch({ items: [] });
    render(<AppealsPage />);

    expect((await screen.findAllByText('Апелляций нет')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /одобрить/i })).not.toBeInTheDocument();
  });

  it('shows an error banner when the queue request fails', async () => {
    stubFetch({ listStatus: 500 });
    render(<AppealsPage />);

    expect(await screen.findByText('Ошибка запроса')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('approves an appeal with the applicant-facing note', async () => {
    const calls = stubFetch();
    render(<AppealsPage />);
    await screen.findByText('#7');

    await userEvent.type(screen.getByPlaceholderText(/ответ заявителю/i), 'бан снят');
    await userEvent.click(screen.getByRole('button', { name: /одобрить/i }));

    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.init?.method === 'PATCH');
    expect(patch?.url).toBe('/api/v1/appeals/appeal-1');
    expect(JSON.parse(String(patch?.init?.body))).toMatchObject({
      status: 'approved',
      decision_note: 'бан снят',
    });
  });
});
