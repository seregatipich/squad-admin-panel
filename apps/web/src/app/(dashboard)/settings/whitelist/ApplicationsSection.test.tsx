// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationsSection } from './ApplicationsSection';

const TEST_TIMEOUT_MS = 15_000;

const SETTINGS = { enabled: true, default_days: 30 };
const ROLES = [
  { id: 'role-vip', name: 'VIP', is_system_role: false },
  { id: 'role-owner', name: 'Owner', is_system_role: true },
];

function pendingItem(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'app-1',
    steam_id64: '76561198000000001',
    player_id: 'player-1',
    player_name: 'Rambo',
    contact: 'discord#1',
    body: 'пустите меня',
    requested_role_id: 'role-vip',
    requested_role_name: 'VIP',
    status: 'pending',
    reviewer_name: null,
    review_note: null,
    granted_role_name: null,
    granted_until: null,
    source: 'public',
    verified: false,
    created_at: '2026-07-20T10:00:00.000Z',
    decided_at: null,
    ...over,
  };
}

function mockFetch(
  opts: {
    items?: unknown[];
    patchStatus?: number;
    /** Total rows the API reports — may exceed `items.length` for a single page. */
    total?: number;
    /** Serves a different page's items keyed by the requested `page` param. */
    pages?: Record<string, unknown[]>;
  } = {},
) {
  const items = opts.items ?? [pendingItem()];
  const total = opts.total ?? items.length;
  const patchStatus = opts.patchStatus ?? 200;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.includes('/api/v1/whitelist/applications/settings')) {
      if (init?.method === 'PUT') {
        return Promise.resolve(new Response(String(init.body), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(SETTINGS), { status: 200 }));
    }
    if (url.includes('/api/v1/whitelist/applications/') && init?.method === 'PATCH') {
      const status = patchStatus === 200 ? 200 : patchStatus;
      const body =
        status === 200
          ? JSON.stringify({ id: 'app-1', status: 'approved' })
          : JSON.stringify({ error: 'boom' });
      return Promise.resolve(new Response(body, { status }));
    }
    if (url.includes('/api/v1/whitelist/applications')) {
      const requestedPage = new URL(url, 'http://localhost').searchParams.get('page') ?? '1';
      const pageItems = opts.pages?.[requestedPage] ?? items;
      return Promise.resolve(
        new Response(
          JSON.stringify({ items: pageItems, total, page: Number(requestedPage), page_size: 20 }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith('/api/v1/roles')) {
      return Promise.resolve(new Response(JSON.stringify(ROLES), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  return { fn, calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ApplicationsSection', () => {
  it(
    'lists pending applications',
    async () => {
      const { fn } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<ApplicationsSection canEdit={true} canManageRoles={true} />);
      expect(await screen.findByText('76561198000000001')).toBeInTheDocument();
      expect(screen.getByText(/пустите меня/)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'marks whether the applicant proved ownership of the SteamID64 (#52)',
    async () => {
      const { fn } = mockFetch({
        items: [
          pendingItem(),
          pendingItem({ id: 'app-2', steam_id64: '76561198000000002', verified: true }),
        ],
      });
      vi.stubGlobal('fetch', fn);
      render(<ApplicationsSection canEdit={true} canManageRoles={true} />);
      await screen.findByText('76561198000000002');
      expect(screen.getByText('SteamID не подтверждён')).toBeInTheDocument();
      expect(screen.getByText('SteamID подтверждён входом через Steam')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders the empty state when there are no applications',
    async () => {
      const { fn } = mockFetch({ items: [] });
      vi.stubGlobal('fetch', fn);
      render(<ApplicationsSection canEdit={true} canManageRoles={true} />);
      expect(await screen.findByText(/заявок нет/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the true total, not just the current page size, and paginates beyond the first page (#722)',
    async () => {
      const firstPage = Array.from({ length: 20 }, (_, i) =>
        pendingItem({
          id: `app-${i + 1}`,
          steam_id64: `7656119800000${String(i + 1).padStart(4, '0')}`,
        }),
      );
      const secondPageItem = pendingItem({ id: 'app-21', steam_id64: '76561198000099999' });
      const { fn, calls } = mockFetch({
        items: firstPage,
        total: 21,
        pages: { '1': firstPage, '2': [secondPageItem] },
      });
      vi.stubGlobal('fetch', fn);
      render(<ApplicationsSection canEdit={true} canManageRoles={true} />);

      // The header count must reflect the API's `total`, not `items.length`
      // (which is capped at the page size).
      expect(await screen.findByText('21')).toBeInTheDocument();
      expect(screen.queryByText('76561198000099999')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Вперёд' }));

      expect(await screen.findByText('76561198000099999')).toBeInTheDocument();
      const listCalls = calls.filter((c) => c.url.includes('/api/v1/whitelist/applications?'));
      expect(listCalls.at(-1)?.url).toContain('page=2');
      expect(listCalls.at(-1)?.url).toContain('page_size=20');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides approve/reject controls without whitelist:edit',
    async () => {
      const { fn } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<ApplicationsSection canEdit={false} canManageRoles={false} />);
      await screen.findByText('76561198000000001');
      expect(screen.queryByRole('button', { name: /одобрить/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /отклонить/i })).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sends role + explicit expires_at when approving with a term preset',
    async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<ApplicationsSection canEdit={true} canManageRoles={true} />);
      await screen.findByText('76561198000000001');

      // pick the 90-day term, then approve
      const termSelect = screen.getByDisplayValue('По умолчанию');
      fireEvent.change(termSelect, { target: { value: '90' } });
      fireEvent.click(screen.getByRole('button', { name: /одобрить/i }));

      await waitFor(() => expect(screen.getByText(/заявка одобрена/i)).toBeInTheDocument());
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const payload = JSON.parse(String(patch?.init?.body)) as Record<string, unknown>;
      expect(payload.status).toBe('approved');
      expect(payload.role_id).toBe('role-vip'); // defaulted to requested role
      expect(typeof payload.expires_at).toBe('string');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sends status rejected with the review note when rejecting',
    async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<ApplicationsSection canEdit={true} canManageRoles={true} />);
      await screen.findByText('76561198000000001');

      fireEvent.change(screen.getByLabelText(/комментарий/i), {
        target: { value: 'нет мест' },
      });
      fireEvent.click(screen.getByRole('button', { name: /отклонить/i }));

      await waitFor(() => expect(screen.getByText(/заявка отклонена/i)).toBeInTheDocument());
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      const payload = JSON.parse(String(patch?.init?.body)) as Record<string, unknown>;
      expect(payload.status).toBe('rejected');
      expect(payload.review_note).toBe('нет мест');
      expect(payload.role_id).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'surfaces an API error when a decision fails',
    async () => {
      const { fn } = mockFetch({ patchStatus: 409 });
      vi.stubGlobal('fetch', fn);
      render(<ApplicationsSection canEdit={true} canManageRoles={true} />);
      await screen.findByText('76561198000000001');

      fireEvent.click(screen.getByRole('button', { name: /одобрить/i }));
      await waitFor(() =>
        expect(screen.getByText(/не удалось обработать заявку/i)).toBeInTheDocument(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'hides the role picker and sends no role_id without user:manage_roles (#8)',
    async () => {
      const { fn, calls } = mockFetch();
      vi.stubGlobal('fetch', fn);
      render(<ApplicationsSection canEdit={true} canManageRoles={false} />);
      await screen.findByText('76561198000000001');
      expect(screen.queryByDisplayValue('VIP')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /одобрить/i }));

      await waitFor(() => expect(screen.getByText(/заявка одобрена/i)).toBeInTheDocument());
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      const payload = JSON.parse(String(patch?.init?.body)) as Record<string, unknown>;
      expect(payload.status).toBe('approved');
      expect(payload.role_id).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
