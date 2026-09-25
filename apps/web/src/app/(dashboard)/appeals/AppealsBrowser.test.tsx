// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/appeals'),
  useRouter: vi.fn(() => ({ replace })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/use-live-bus', () => ({ useLiveSubscription: () => undefined }));

import { AppealsBrowser } from './AppealsBrowser';

const TEST_TIMEOUT_MS = 15_000;

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

function stubFetch(opts: { items?: unknown[]; listStatus?: number; patchStatus?: number } = {}): {
  fn: ReturnType<typeof vi.fn>;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const items = opts.items ?? [PENDING_APPEAL];
  const listStatus = opts.listStatus ?? 200;
  const patchStatus = opts.patchStatus ?? 200;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (init?.method === 'PATCH') {
      const body =
        patchStatus === 200
          ? JSON.stringify({ appeal: { ...PENDING_APPEAL, status: 'approved' }, revert: null })
          : JSON.stringify({ error: 'appeal_already_decided' });
      return Promise.resolve(new Response(body, { status: patchStatus }));
    }
    if (url.startsWith('/api/v1/appeals')) {
      if (listStatus !== 200) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'forbidden' }), { status: listStatus }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ items, total: items.length, page: 1, page_size: 20 }), {
          status: 200,
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  return { fn, calls };
}

afterEach(() => {
  cleanup();
  replace.mockClear();
  vi.unstubAllGlobals();
});

describe('AppealsBrowser', () => {
  it(
    'lists the pending queue with the appeal number and the appealed ban',
    async () => {
      vi.stubGlobal('fetch', stubFetch().fn);
      render(<AppealsBrowser />);

      expect(await screen.findByText('#7')).toBeInTheDocument();
      expect(screen.getByText(/забанили по ошибке/)).toBeInTheDocument();
      expect(screen.getByText(/aimbot/)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders the empty state when the queue has no appeals',
    async () => {
      vi.stubGlobal('fetch', stubFetch({ items: [] }).fn);
      render(<AppealsBrowser />);
      expect(await screen.findByText(/апелляций нет/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'self-hides the queue when the API answers 403',
    async () => {
      vi.stubGlobal('fetch', stubFetch({ listStatus: 403 }).fn);
      render(<AppealsBrowser />);
      expect(await screen.findByText(/недостаточно прав/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /одобрить/i })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sends status approved together with the applicant-facing decision note',
    async () => {
      const { fn, calls } = stubFetch();
      vi.stubGlobal('fetch', fn);
      render(<AppealsBrowser />);
      await screen.findByText('#7');

      fireEvent.change(screen.getByPlaceholderText(/ответ заявителю/i), {
        target: { value: 'бан снят' },
      });
      fireEvent.click(screen.getByRole('button', { name: /одобрить/i }));

      await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true));
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch?.url).toBe('/api/v1/appeals/appeal-1');
      const payload = JSON.parse(String(patch?.init?.body)) as Record<string, unknown>;
      expect(payload.status).toBe('approved');
      expect(payload.decision_note).toBe('бан снят');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sends the internal note separately from the applicant-facing note',
    async () => {
      const { fn, calls } = stubFetch();
      vi.stubGlobal('fetch', fn);
      render(<AppealsBrowser />);
      await screen.findByText('#7');

      fireEvent.change(screen.getByPlaceholderText(/внутренняя заметка/i), {
        target: { value: 'проверил логи' },
      });
      fireEvent.click(screen.getByRole('button', { name: /отклонить/i }));

      await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true));
      const payload = JSON.parse(
        String(calls.find((c) => c.init?.method === 'PATCH')?.init?.body),
      ) as Record<string, unknown>;
      expect(payload.status).toBe('rejected');
      expect(payload.internal_note).toBe('проверил логи');
      expect(payload.decision_note).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'takes an appeal into review',
    async () => {
      const { fn, calls } = stubFetch();
      vi.stubGlobal('fetch', fn);
      render(<AppealsBrowser />);
      await screen.findByText('#7');

      fireEvent.click(screen.getByRole('button', { name: /в работу/i }));

      await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true));
      const payload = JSON.parse(
        String(calls.find((c) => c.init?.method === 'PATCH')?.init?.body),
      ) as Record<string, unknown>;
      expect(payload.status).toBe('in_review');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides decision controls for an already decided appeal',
    async () => {
      const decided = {
        ...PENDING_APPEAL,
        status: 'approved' as const,
        decided_at: '2026-07-21T10:00:00.000Z',
        decision_note: 'бан снят',
        handler: { id: 'mod-1', name: 'Moderator' },
      };
      vi.stubGlobal('fetch', stubFetch({ items: [decided] }).fn);
      render(<AppealsBrowser />);

      await screen.findByText('#7');
      expect(screen.queryByRole('button', { name: /одобрить/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /в работу/i })).toBeNull();
      expect(screen.getByText(/Moderator/)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'surfaces an API error when a decision fails',
    async () => {
      vi.stubGlobal('fetch', stubFetch({ patchStatus: 409 }).fn);
      render(<AppealsBrowser />);
      await screen.findByText('#7');

      fireEvent.click(screen.getByRole('button', { name: /одобрить/i }));
      await waitFor(() => expect(screen.getByText(/appeal_already_decided/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'pushes the status filter into the URL',
    async () => {
      vi.stubGlobal('fetch', stubFetch().fn);
      render(<AppealsBrowser />);
      await screen.findByText('#7');

      // Фильтр статусов — сегментированный переключатель (`role="tab"`),
      // а не ряд кнопок: проверяем ту же связь «выбор → адрес».
      fireEvent.click(screen.getByRole('tab', { name: 'Одобренные' }));
      await waitFor(() => expect(replace).toHaveBeenCalled());
      expect(String(replace.mock.calls.at(-1)?.[0])).toContain('status=approved');
    },
    TEST_TIMEOUT_MS,
  );
});
