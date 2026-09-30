// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSearchParams } from 'next/navigation';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/appeals'),
  useRouter: vi.fn(() => ({ replace })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
type LiveHandler = () => void;
let liveHandlers: Partial<Record<string, LiveHandler>> = {};
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (type: string, handler: LiveHandler) => {
    liveHandlers[type] = handler;
  },
}));

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
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
  );
  vi.unstubAllGlobals();
  liveHandlers = {};
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
    'surfaces a Russian message for a known error code when a decision fails (#491)',
    async () => {
      vi.stubGlobal('fetch', stubFetch({ patchStatus: 409 }).fn);
      render(<AppealsBrowser />);
      await screen.findByText('#7');

      fireEvent.click(screen.getByRole('button', { name: /одобрить/i }));
      await waitFor(() =>
        expect(screen.getByText(/уже решена другим модератором/i)).toBeInTheDocument(),
      );
      expect(screen.queryByText(/appeal_already_decided/i)).not.toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows a Russian message instead of rendering when the list response has a wrong shape (#491)',
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve(new Response(JSON.stringify({ items: 'oops' }), { status: 200 })),
        ),
      );
      render(<AppealsBrowser />);
      await waitFor(() =>
        expect(screen.getByText(/Неожиданный формат ответа сервера/)).toBeInTheDocument(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'jumps back to the last page when a decision empties the current one (#487)',
    async () => {
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('page=2') as unknown as ReturnType<typeof useSearchParams>,
      );
      let listCallCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (init?.method === 'PATCH') {
            return Promise.resolve(
              new Response(JSON.stringify({ appeal: { ...PENDING_APPEAL, status: 'approved' } }), {
                status: 200,
              }),
            );
          }
          if (url.startsWith('/api/v1/appeals')) {
            listCallCount += 1;
            // First load: the single item on page 2 of 2 (total=21, page_size=20).
            // Reload after the decision: total drops to 20 (1 page) — the
            // second call must clamp `page` back to 1 rather than rendering
            // page 2 as empty.
            const body =
              listCallCount === 1
                ? { items: [PENDING_APPEAL], total: 21, page: 2, page_size: 20 }
                : { items: [], total: 20, page: 2, page_size: 20 };
            return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
          }
          return Promise.reject(new Error(`unexpected fetch: ${url}`));
        }),
      );
      render(<AppealsBrowser />);
      await screen.findByText('#7');

      fireEvent.click(screen.getByRole('button', { name: /одобрить/i }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/appeals'));
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

  it(
    'keeps an in-progress reply draft on an unrelated live event, instead of remounting the list (#486)',
    async () => {
      const items = [PENDING_APPEAL];
      let listCalls = 0;
      const secondResponse = (() => {
        let resolve!: (value: Response) => void;
        const promise = new Promise<Response>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      })();
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/v1/appeals')) {
          listCalls += 1;
          const body = JSON.stringify({ items, total: items.length, page: 1, page_size: 20 });
          if (listCalls === 1) {
            return Promise.resolve(new Response(body, { status: 200 }));
          }
          // The refetch triggered by the live event: held back so we can
          // observe whether the list is swapped for a Skeleton while it's
          // in flight, same as a real (non-instant) network round trip.
          return secondResponse.promise;
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<AppealsBrowser />);
      await screen.findByText('#7');

      const noteField = screen.getByPlaceholderText(
        'Ответ заявителю (необязательно)',
      ) as HTMLTextAreaElement;
      noteField.focus();
      fireEvent.change(noteField, { target: { value: 'draft in progress' } });
      expect(document.activeElement).toBe(noteField);

      // A completely unrelated appeal.created/updated event fires — while its
      // refetch is in flight, the list must not be swapped for a Skeleton
      // (which would unmount noteField and drop the operator's focus/cursor
      // and draft, per #486).
      liveHandlers['appeal.created']?.();
      await waitFor(() => expect(listCalls).toBe(2));

      expect(screen.queryByLabelText('Загрузка апелляций')).not.toBeInTheDocument();
      const noteFieldMidFlight = screen.getByPlaceholderText(
        'Ответ заявителю (необязательно)',
      ) as HTMLTextAreaElement;
      expect(noteFieldMidFlight).toBe(noteField);
      expect(noteFieldMidFlight.value).toBe('draft in progress');
      expect(document.activeElement).toBe(noteFieldMidFlight);

      secondResponse.resolve(
        new Response(JSON.stringify({ items, total: items.length, page: 1, page_size: 20 }), {
          status: 200,
        }),
      );
      await waitFor(() => expect(screen.getByText('#7')).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );
});
