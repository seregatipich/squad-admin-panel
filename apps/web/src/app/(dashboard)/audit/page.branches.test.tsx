// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/audit'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import AuditPage from './page';

// Tokens are disjoint per field so a filter query hits exactly one OR operand.
const ITEMS = [
  {
    id: 'a1',
    created_at: '2026-07-23T10:00:00Z',
    actor_user_id: 'deltauser1234567',
    actor_kind: 'user',
    action_type: 'alpha.action',
    target_type: 'beta',
    target_id: 'gamma-id-0001',
    status_code: 201, // < 300 → emerald
    duration_ms: 12,
    context: { x: 1 },
    row_hash: 'r'.repeat(64),
    prev_hash: 'p'.repeat(64),
  },
  {
    id: 'a2',
    created_at: '2026-07-23T10:01:00Z',
    actor_user_id: null,
    actor_kind: 'user',
    action_type: 'ban',
    target_type: null,
    target_id: null,
    status_code: 301, // < 400 → sky
    duration_ms: null,
    context: {},
    row_hash: null,
    prev_hash: null,
  },
  {
    id: 'a3',
    created_at: '2026-07-23T10:02:00Z',
    actor_user_id: null,
    actor_kind: 'system',
    action_type: 'sync',
    target_type: 'server',
    target_id: null,
    status_code: 404, // < 500 → amber
    duration_ms: 0,
    context: {},
  },
  {
    id: 'a4',
    created_at: '2026-07-23T10:03:00Z',
    actor_user_id: null,
    actor_kind: 'bot',
    action_type: 'cleanup',
    target_type: null,
    target_id: null,
    status_code: 500, // >= 500 → red
    duration_ms: 3,
    context: {},
  },
  {
    id: 'a5',
    created_at: '2026-07-23T10:04:00Z',
    actor_user_id: null,
    actor_kind: 'system',
    action_type: 'noop',
    target_type: null,
    target_id: null,
    status_code: null, // null → '—'
    duration_ms: 1,
    context: {},
  },
];

let listItems: unknown[] = ITEMS;

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.startsWith('/api/v1/audit/verify-chain')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, checked: 1, broken_at: null, reason: null }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ items: listItems }), { status: 200 }));
    }),
  );
}

beforeEach(() => {
  listItems = ITEMS;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuditPage — branch coverage', () => {
  it('renders status tones, actor and target fallbacks for varied rows', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');

    // Status-code tones (StatusCode component)
    expect(screen.getByText('201')).toHaveClass('text-emerald-400');
    expect(screen.getByText('301')).toHaveClass('text-sky-400');
    expect(screen.getByText('404')).toHaveClass('text-amber-400');
    expect(screen.getByText('500')).toHaveClass('text-red-400');

    // Actor cell: user w/ id → 8-char slice; user w/o id / non-user → kind or '—'
    expect(screen.getByText('deltause')).toBeInTheDocument();
    expect(screen.getAllByText('bot').length).toBeGreaterThanOrEqual(1);

    // Target cell: truthy target_type with sliced id, and '—' fallbacks
    expect(screen.getByText(/beta gamma-id-000/)).toBeInTheDocument();
  });

  it('filters on the action_type operand', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'alpha' },
    });
    expect(screen.getByText('alpha.action')).toBeInTheDocument();
    expect(screen.queryByText('ban')).not.toBeInTheDocument();
  });

  it('filters on the target_type operand', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'beta' },
    });
    expect(screen.getByText('alpha.action')).toBeInTheDocument();
    expect(screen.queryByText('cleanup')).not.toBeInTheDocument();
  });

  it('filters on the target_id operand', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'gamma' },
    });
    expect(screen.getByText('alpha.action')).toBeInTheDocument();
    expect(screen.queryByText('noop')).not.toBeInTheDocument();
  });

  it('filters on the actor_user_id operand', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'deltauser' },
    });
    expect(screen.getByText('alpha.action')).toBeInTheDocument();
    expect(screen.queryByText('sync')).not.toBeInTheDocument();
  });

  it('shows the no-match empty state when a filter matches nothing', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'zzzz-no-match' },
    });
    expect(screen.getByText('Нет совпадений.')).toBeInTheDocument();
  });

  it('shows the empty-journal state when there are no entries', async () => {
    listItems = [];
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('Журнал пуст.')).toBeInTheDocument());
  });

  it('expands a row with hashes and collapses it again', async () => {
    render(<AuditPage />);
    const actionCell = await screen.findByText('alpha.action');

    // Expand → context + hash detail visible (prev_hash present branch)
    fireEvent.click(actionCell);
    await waitFor(() => expect(document.body.textContent).toContain('r'.repeat(64)));
    expect(document.body.textContent).toContain('p'.repeat(64));

    // Collapse (expanded === r.id ? null : r.id → null branch)
    fireEvent.click(actionCell);
    await waitFor(() => expect(document.body.textContent).not.toContain('r'.repeat(64)));
  });

  it('expands a row without a row_hash (no hash detail block)', async () => {
    render(<AuditPage />);
    const banCell = await screen.findByText('ban');
    fireEvent.click(banCell);
    // Row expands (context shown) but there is no row_hash dl block.
    await waitFor(() => {
      const detail = screen.getByText('{}');
      expect(detail).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain('row_hash:');
  });
});
