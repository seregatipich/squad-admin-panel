// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IssueLinksBlock } from './IssueLinksBlock';
import type { IssueLinkView } from './issue-links';

const TEST_TIMEOUT_MS = 15_000;

function link(overrides: Partial<IssueLinkView> = {}): IssueLinkView {
  return {
    id: 'link-1',
    issue_id: 'issue-1',
    entity_type: 'player',
    entity_id: 'player-1',
    label: 'Vasya',
    ref: '/all-players/player-1',
    exists: true,
    created_by: 'author-1',
    created_at: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

interface RouteStub {
  status: number;
  body?: unknown;
}

function stubRoutes(
  routes: Array<[RegExp, RouteStub]>,
  onCall?: (url: string, init?: RequestInit) => void,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      onCall?.(url, init);
      for (const [pattern, stub] of routes) {
        if (pattern.test(url)) {
          return Promise.resolve(
            new Response(stub.body !== undefined ? JSON.stringify(stub.body) : null, {
              status: stub.status,
            }),
          );
        }
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
}

const SERVERS_OK: [RegExp, RouteStub] = [
  /\/api\/v1\/servers/,
  { status: 200, body: { items: [{ id: 'srv-1', display_name: 'Alpha Server' }], total: 1 } },
];
const SERVERS_FORBIDDEN: [RegExp, RouteStub] = [/\/api\/v1\/servers/, { status: 403 }];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('IssueLinksBlock', () => {
  it(
    'renders each link with its type label and a clickable ref',
    async () => {
      stubRoutes([SERVERS_OK]);
      render(
        <IssueLinksBlock
          issueId="issue-1"
          links={[
            link(),
            link({
              id: 'link-2',
              entity_type: 'server',
              entity_id: 'srv-1',
              label: 'Alpha Server',
              ref: '/servers/srv-1',
            }),
          ]}
          viewer={null}
          onChanged={vi.fn()}
        />,
      );

      await screen.findByText('Связанные объекты');
      // Scoped to the list: the same Russian words also label the picker's options.
      const list = within(screen.getByRole('list'));
      expect(list.getByText('Игрок')).toBeInTheDocument();
      expect(list.getByText('Сервер')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Vasya' })).toHaveAttribute(
        'href',
        '/all-players/player-1',
      );
      expect(screen.getByRole('link', { name: 'Alpha Server' })).toHaveAttribute(
        'href',
        '/servers/srv-1',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders a deleted target as plain non-clickable text',
    async () => {
      stubRoutes([SERVERS_OK]);
      render(
        <IssueLinksBlock
          issueId="issue-1"
          links={[link({ label: 'Удалённый объект', ref: null, exists: false })]}
          viewer={null}
          onChanged={vi.fn()}
        />,
      );

      await screen.findByText('Удалённый объект');
      expect(screen.queryByRole('link', { name: 'Удалённый объект' })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an empty state when the ticket has no links',
    async () => {
      stubRoutes([SERVERS_OK]);
      render(<IssueLinksBlock issueId="issue-1" links={[]} viewer={null} onChanged={vi.fn()} />);

      await screen.findByText('Связанных объектов нет.');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'offers a remove button only for links the viewer may remove',
    async () => {
      stubRoutes([SERVERS_OK]);
      render(
        <IssueLinksBlock
          issueId="issue-1"
          links={[
            link({ id: 'mine', label: 'Mine', created_by: 'me' }),
            link({ id: 'theirs', label: 'Theirs', created_by: 'someone-else' }),
          ]}
          viewer={{ player_id: 'me', can_manage_issues: false }}
          onChanged={vi.fn()}
        />,
      );

      await screen.findByRole('button', { name: 'Удалить связь: Mine' });
      expect(screen.queryByRole('button', { name: 'Удалить связь: Theirs' })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'deletes a link and asks the page to reload',
    async () => {
      const calls: Array<{ url: string; method?: string }> = [];
      stubRoutes(
        [SERVERS_OK, [/\/api\/v1\/issues\/issue-1\/links\//, { status: 200, body: { ok: true } }]],
        (url, init) => calls.push({ url, method: init?.method }),
      );
      const onChanged = vi.fn();
      render(
        <IssueLinksBlock
          issueId="issue-1"
          links={[link({ id: 'link-9', label: 'Mine', created_by: 'me' })]}
          viewer={{ player_id: 'me', can_manage_issues: false }}
          onChanged={onChanged}
        />,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Удалить связь: Mine' }));

      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(
        calls.some(
          (c) => c.method === 'DELETE' && c.url.endsWith('/api/v1/issues/issue-1/links/link-9'),
        ),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'surfaces a 403 from the delete endpoint as a Russian message',
    async () => {
      stubRoutes([
        SERVERS_OK,
        [
          /\/api\/v1\/issues\/issue-1\/links\//,
          { status: 403, body: { error: 'forbidden', required: 'can_manage_issues' } },
        ],
      ]);
      render(
        <IssueLinksBlock
          issueId="issue-1"
          links={[link({ id: 'link-9', label: 'Mine', created_by: 'me' })]}
          viewer={{ player_id: 'me', can_manage_issues: false }}
          onChanged={vi.fn()}
        />,
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Удалить связь: Mine' }));
      await screen.findByText('Недостаточно прав: нужно can_manage_issues.');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the server option when GET /api/v1/servers is forbidden',
    async () => {
      stubRoutes([SERVERS_FORBIDDEN]);
      render(<IssueLinksBlock issueId="issue-1" links={[]} viewer={null} onChanged={vi.fn()} />);

      await screen.findByText('Связанных объектов нет.');
      const typeSelect = screen.getByLabelText('Тип объекта');
      await waitFor(() =>
        expect(
          Array.from(typeSelect.querySelectorAll('option')).map((o) => o.getAttribute('value')),
        ).toEqual(['player']),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'attaches the picked server and asks the page to reload',
    async () => {
      const calls: Array<{ url: string; method?: string; body?: string }> = [];
      stubRoutes(
        [
          [/\/api\/v1\/issues\/issue-1\/links$/, { status: 201, body: { id: 'new-link' } }],
          SERVERS_OK,
        ],
        (url, init) =>
          calls.push({ url, method: init?.method, body: init?.body as string | undefined }),
      );
      const onChanged = vi.fn();
      render(<IssueLinksBlock issueId="issue-1" links={[]} viewer={null} onChanged={onChanged} />);

      const typeSelect = await screen.findByLabelText('Тип объекта');
      await waitFor(() => expect(typeSelect.querySelectorAll('option')).toHaveLength(2));
      fireEvent.change(typeSelect, { target: { value: 'server' } });

      const serverSelect = await screen.findByLabelText('Сервер для связи');
      fireEvent.change(serverSelect, { target: { value: 'srv-1' } });

      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toBe(JSON.stringify({ entity_type: 'server', entity_id: 'srv-1' }));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'attaches a player picked through the autocomplete',
    async () => {
      const calls: Array<{ url: string; method?: string; body?: string }> = [];
      stubRoutes(
        [
          [/\/api\/v1\/issues\/issue-1\/links$/, { status: 201, body: { id: 'new-link' } }],
          [
            /\/api\/v1\/players\?q=/,
            { status: 200, body: { items: [{ id: 'p-7', canonical_name: 'Vasya Pupkin' }] } },
          ],
          SERVERS_OK,
        ],
        (url, init) =>
          calls.push({ url, method: init?.method, body: init?.body as string | undefined }),
      );
      const onChanged = vi.fn();
      render(<IssueLinksBlock issueId="issue-1" links={[]} viewer={null} onChanged={onChanged} />);

      fireEvent.change(await screen.findByPlaceholderText('Связать с игроком'), {
        target: { value: 'Vasya' },
      });
      fireEvent.click(await screen.findByText('Vasya Pupkin', {}, { timeout: 5000 }));

      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toBe(JSON.stringify({ entity_type: 'player', entity_id: 'p-7' }));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'surfaces a duplicate link as a Russian message',
    async () => {
      stubRoutes([
        [/\/api\/v1\/issues\/issue-1\/links$/, { status: 409, body: { error: 'link_exists' } }],
        SERVERS_OK,
      ]);
      render(<IssueLinksBlock issueId="issue-1" links={[]} viewer={null} onChanged={vi.fn()} />);

      const typeSelect = await screen.findByLabelText('Тип объекта');
      await waitFor(() => expect(typeSelect.querySelectorAll('option')).toHaveLength(2));
      fireEvent.change(typeSelect, { target: { value: 'server' } });
      fireEvent.change(await screen.findByLabelText('Сервер для связи'), {
        target: { value: 'srv-1' },
      });

      await screen.findByText('Такая связь уже существует.');
    },
    TEST_TIMEOUT_MS,
  );
});
