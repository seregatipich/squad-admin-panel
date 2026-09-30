// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IssueView } from '@/lib/live-bus';

let mockSearchParams = new URLSearchParams();
const replaceMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ replace: replaceMock })),
  usePathname: vi.fn(() => '/issues'),
  useSearchParams: vi.fn(() => mockSearchParams),
}));

const liveHandlers = new Map<string, (event: unknown) => void>();
vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: (type: string, handler: (event: unknown) => void) => {
    liveHandlers.set(type, handler);
  },
}));

import { IssuesBrowser } from './IssuesBrowser';

function issue(id: string, title: string, overrides: Partial<IssueView> = {}): IssueView {
  return {
    id,
    number: 1,
    title,
    body: 'body',
    state: 'open',
    author_player_id: 'p1',
    assignee_player_id: null,
    author: { id: 'p1', name: 'Author' },
    assignee: null,
    labels: [],
    created_at: '2026-09-25T10:00:00.000Z',
    updated_at: '2026-09-25T10:00:00.000Z',
    closed_at: null,
    ...overrides,
  };
}

function mockFetch(items: IssueView[]) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/v1/issues/labels')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/issues')) {
      return Promise.resolve(
        new Response(JSON.stringify({ items, total: items.length, page: 1, per_page: 25 }), {
          status: 200,
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  liveHandlers.clear();
  vi.unstubAllGlobals();
  replaceMock.mockClear();
  mockSearchParams = new URLSearchParams();
});

/*
 * ISSUES-558: issueMatchesFilters ignores filters.q, so a live
 * issue.created/issue.updated event could insert a ticket into an active
 * search's results that the server-side search_vector query would exclude.
 */
describe('IssuesBrowser — ISSUES-558 живые события не игнорируют поиск', () => {
  it('не вставляет новый тикет из живого события, пока активен поиск q', async () => {
    mockSearchParams = new URLSearchParams('q=краш');
    vi.stubGlobal('fetch', mockFetch([issue('issue-1', 'Краш при загрузке карты')]));
    render(<IssuesBrowser />);
    await screen.findByText('Краш при загрузке карты');

    await act(async () => {
      liveHandlers.get('issue.created')?.({
        data: { issue: issue('issue-new', 'Игрок не может подключиться') },
      });
    });

    expect(screen.queryByText('Игрок не может подключиться')).not.toBeInTheDocument();
    expect(screen.getByText('Краш при загрузке карты')).toBeInTheDocument();
  });

  it('обновляет тикет на месте, если он уже показан под активным поиском', async () => {
    mockSearchParams = new URLSearchParams('q=краш');
    vi.stubGlobal('fetch', mockFetch([issue('issue-1', 'Краш при загрузке карты')]));
    render(<IssuesBrowser />);
    await screen.findByText('Краш при загрузке карты');

    await act(async () => {
      liveHandlers.get('issue.updated')?.({
        data: { issue: issue('issue-1', 'Краш при загрузке карты (обновлено)') },
      });
    });

    expect(screen.getByText('Краш при загрузке карты (обновлено)')).toBeInTheDocument();
  });

  it('без активного поиска новый тикет из живого события всё ещё появляется', async () => {
    vi.stubGlobal('fetch', mockFetch([issue('issue-1', 'Первый тикет')]));
    render(<IssuesBrowser />);
    await screen.findByText('Первый тикет');

    await act(async () => {
      liveHandlers.get('issue.created')?.({
        data: { issue: issue('issue-new', 'Новый тикет') },
      });
    });

    expect(await screen.findByText('Новый тикет')).toBeInTheDocument();
  });
});
