// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let mockSearchParams = new URLSearchParams();
const replaceMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: replaceMock })),
  usePathname: vi.fn(() => '/events'),
  useSearchParams: vi.fn(() => mockSearchParams),
}));

const liveHandlers = new Map<string, (event: unknown) => void>();
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (type: string, handler: (event: unknown) => void) => {
    liveHandlers.set(type, handler);
  },
}));

import { EventsBrowser } from './EventsBrowser';

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/events/count')) {
      return Promise.resolve(new Response(JSON.stringify({ total: 0 }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/events')) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], next_cursor: null, limit: 50 }), {
          status: 200,
        }),
      );
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  liveHandlers.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  replaceMock.mockClear();
  mockSearchParams = new URLSearchParams();
});

describe('EventsBrowser — BANNAME-3 rule filter chip', () => {
  it('shows no rule chip without a ?rule param', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser />);
    await screen.findByRole('link', { name: 'Экспорт CSV' });
    expect(screen.queryByText(/правило:/i)).not.toBeInTheDocument();
  });

  it('shows a removable «Правило: …» chip when ?rule is set, and clears it on click', async () => {
    mockSearchParams = new URLSearchParams('rule=22222222-2222-2222-2222-222222222222');
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser />);
    const chip = await screen.findByText(/правило: 22222222/i);
    expect(chip).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /убрать фильтр по правилу/i }));
    expect(replaceMock).toHaveBeenCalledWith(expect.not.stringContaining('rule='));
  });

  it('sends ruleId on the events list/count requests when ?rule is set', async () => {
    mockSearchParams = new URLSearchParams('rule=rule-abc');
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<EventsBrowser />);
    await screen.findByRole('link', { name: 'Экспорт CSV' });
    const calledUrls = fetchMock.mock.calls.map(([input]) =>
      typeof input === 'string' ? input : String(input),
    );
    expect(calledUrls.some((url) => url.includes('ruleId=rule-abc'))).toBe(true);
  });
});

describe('EventsBrowser — заголовки', () => {
  it('не рендерит собственный <h1>: на верхнем уровне его даёт страница', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser />);
    await screen.findByRole('link', { name: 'Экспорт CSV' });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('во вложенном режиме сервера даёт только заголовок раздела', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<EventsBrowser lockedServerId="srv-1" />);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Журнал событий' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });
});

function eventItem(id: string, kind = 'player.connected', serverId = 'srv-1') {
  return {
    event_id: id,
    server_id: serverId,
    server_name: 'Server',
    server_slug: 'server',
    occurred_at: '2026-09-25T10:00:00.000Z',
    kind,
    version: 1,
    actor_kind: 'system',
    actor_id: null,
    actor_nickname: null,
    correlation_id: null,
  };
}

/** Каждый запрос списка отдаёт следующую страницу из `pages` (последняя — навсегда). */
function listFetch(pages: ReturnType<typeof eventItem>[][]) {
  let call = 0;
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/events/count')) {
      return Promise.resolve(new Response(JSON.stringify({ total: 1 }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/events')) {
      const items = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ items, next_cursor: null, limit: 50 }), { status: 200 }),
      );
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function listCalls(fetchMock: ReturnType<typeof listFetch>): number {
  return fetchMock.mock.calls.filter(([input]) => {
    const url = typeof input === 'string' ? input : String(input);
    return url.startsWith('/api/v1/events?');
  }).length;
}

describe('EventsBrowser — живая лента', () => {
  it('подтягивает новое событие сверху, как только API сообщил о вставке', async () => {
    const fetchMock = listFetch([
      [eventItem('evt00001')],
      [eventItem('evt00002'), eventItem('evt00001')],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<EventsBrowser lockedServerId="srv-1" />);
    await screen.findByText('evt00001');
    expect(screen.queryByText('evt00002')).not.toBeInTheDocument();

    await act(async () => {
      liveHandlers.get('server.events.appended')?.({
        type: 'server.events.appended',
        ts: '2026-09-25T10:00:01.000Z',
        data: { server_id: 'srv-1', kinds: ['player.connected'] },
      });
    });
    expect(await screen.findByText('evt00002', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText('evt00001')).toBeInTheDocument();
    expect(listCalls(fetchMock)).toBe(2);
  });

  it('не перечитывает список, если событие не с этого сервера', async () => {
    const fetchMock = listFetch([[eventItem('evt00001')]]);
    vi.stubGlobal('fetch', fetchMock);
    render(<EventsBrowser lockedServerId="srv-1" />);
    await waitFor(() => expect(listCalls(fetchMock)).toBe(1));

    await act(async () => {
      liveHandlers.get('server.events.appended')?.({
        type: 'server.events.appended',
        ts: '2026-09-25T10:00:01.000Z',
        data: { server_id: 'srv-other', kinds: ['player.connected'] },
      });
    });
    await new Promise((r) => setTimeout(r, 1200));
    expect(listCalls(fetchMock)).toBe(1);
  });

  it('склеивает пачку уведомлений в одно перечитывание', async () => {
    const fetchMock = listFetch([
      [eventItem('evt00001')],
      [eventItem('evt00002'), eventItem('evt00001')],
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<EventsBrowser lockedServerId="srv-1" />);
    await waitFor(() => expect(listCalls(fetchMock)).toBe(1));

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        liveHandlers.get('server.events.appended')?.({
          type: 'server.events.appended',
          ts: '2026-09-25T10:00:01.000Z',
          data: { server_id: 'srv-1', kinds: ['combat_damage'] },
        });
      }
    });
    await waitFor(() => expect(listCalls(fetchMock)).toBe(2), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(listCalls(fetchMock)).toBe(2);
  });
});
