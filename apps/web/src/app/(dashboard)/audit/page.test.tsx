// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/audit'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import AuditPage from './page';

const LIST_ITEM = {
  id: '1',
  created_at: '2026-07-23T10:00:00Z',
  actor_user_id: null,
  actor_kind: 'system',
  action_type: 'server.create',
  target_type: 'server',
  target_id: 'srv-1',
  status_code: 200,
  duration_ms: 5,
  context: {},
  row_hash: 'a'.repeat(64),
  prev_hash: null,
};

/** Stubs fetch: audit list on load, verify-chain with the supplied result. */
function stubFetch(verify: unknown) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/v1/audit/verify-chain')) {
      return Promise.resolve(new Response(JSON.stringify(verify), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ items: [LIST_ITEM] }), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuditPage — verify chain', () => {
  it('renders an intact result after clicking the verify button', async () => {
    const fetchMock = stubFetch({ ok: true, checked: 7, broken_at: null, reason: null });
    render(<AuditPage />);

    const button = await screen.findByRole('button', { name: 'Проверить цепочку' });
    fireEvent.click(button);

    await waitFor(() =>
      expect(screen.getByText(/Цепочка цела: проверено записей — 7/)).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/audit/verify-chain',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('renders the break location when the chain is tampered', async () => {
    stubFetch({ ok: false, checked: 2, broken_at: '3', reason: 'row_hash' });
    render(<AuditPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Проверить цепочку' }));

    await waitFor(() =>
      expect(
        screen.getByText(/Обнаружен разрыв цепочки на записи #3 \(row_hash\)/),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces a fetch error from the verify endpoint', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/v1/audit/verify-chain')) {
        return Promise.resolve(new Response('nope', { status: 500 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [LIST_ITEM] }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuditPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Проверить цепочку' }));

    await waitFor(() =>
      expect(screen.getByText(/Проверка цепочки не удалась: HTTP 500/)).toBeInTheDocument(),
    );
  });

  it('exposes the per-entry row_hash in the expanded detail', async () => {
    stubFetch({ ok: true, checked: 1, broken_at: null, reason: null });
    render(<AuditPage />);

    const actionCell = await screen.findByText('server.create');
    fireEvent.click(actionCell);

    await waitFor(() => expect(document.body.textContent).toContain('a'.repeat(64)));
  });
});
