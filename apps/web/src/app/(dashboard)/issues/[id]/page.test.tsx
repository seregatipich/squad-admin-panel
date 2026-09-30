// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-live-bus', () => ({
  useLiveSubscription: () => {},
}));

import IssueTicketPage from './page';

const VALID_ID = '018f1e3a-6f3e-7c3e-9a3e-1234567890ab';

function issueDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_ID,
    number: 42,
    title: 'Заголовок тикета',
    body: 'Тело тикета',
    state: 'open',
    author_player_id: 'author-1',
    assignee_player_id: null,
    author: { id: 'author-1', name: 'Автор' },
    assignee: null,
    labels: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    closed_at: null,
    comments: [],
    links: [],
    ...overrides,
  };
}

function stubFetch(me: Record<string, unknown> | null, issue: Record<string, unknown>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/v1/me')) {
      return Promise.resolve(new Response(me ? JSON.stringify(me) : 'null', { status: 200 }));
    }
    if (url.startsWith('/api/v1/servers')) {
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }
    if (url.startsWith(`/api/v1/issues/${VALID_ID}`)) {
      return Promise.resolve(new Response(JSON.stringify(issue), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('IssueTicketPage', () => {
  it('refuses to fetch a non-UUID route id and shows an error instead', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL) =>
      Promise.reject(new Error('should not be called')),
    );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <IssueTicketPage params={Promise.resolve({ id: '../other-route' })} />
        </Suspense>,
      );
    });

    expect(await screen.findByText('Не удалось загрузить тикет')).toBeInTheDocument();
    const issueCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/v1/issues/'),
    );
    expect(issueCalls).toHaveLength(0);
  });

  it('lets the ticket author close/reopen it without exposing assignee controls', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(
        { player_id: 'author-1', permissions: [], can_manage_issues: false },
        issueDetail(),
      ),
    );

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <IssueTicketPage params={Promise.resolve({ id: VALID_ID })} />
        </Suspense>,
      );
    });

    expect(await screen.findByRole('button', { name: 'Закрыть' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Взять в работу' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Назначить исполнителя')).not.toBeInTheDocument();
  });

  it('hides ticket management entirely for a non-author without can_manage_issues', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(
        { player_id: 'someone-else', permissions: [], can_manage_issues: false },
        issueDetail(),
      ),
    );

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <IssueTicketPage params={Promise.resolve({ id: VALID_ID })} />
        </Suspense>,
      );
    });

    await screen.findByText('Заголовок тикета');
    expect(screen.queryByRole('button', { name: 'Закрыть' })).not.toBeInTheDocument();
  });
});
