// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/audit'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import AuditPage from './page';

// Tokens are disjoint per field so a filter query hits exactly one OR operand.
// actor_kind is only ever 'steam' or 'system' — GET /api/v1/audit never
// returns 'user'/'bot' (audit_log_actor_kind check constraint), and never
// returns actor_user_id at all (#484).
const ITEMS = [
  {
    id: 'a1',
    created_at: '2026-07-23T10:00:00Z',
    actor_kind: 'steam',
    actor_player_id: 'deltauser1234567',
    actor_token_id: null,
    actor_system_label: null,
    action_type: 'alpha.action',
    target_type: 'beta',
    target_id: 'gamma-id-0001',
    status_code: 201, // < 300 → «успех»
    duration_ms: 12,
    context: { x: 1 },
    row_hash: 'r'.repeat(64),
    prev_hash: 'p'.repeat(64),
  },
  {
    id: 'a2',
    created_at: '2026-07-23T10:01:00Z',
    actor_kind: 'steam',
    actor_player_id: null,
    actor_token_id: null,
    actor_system_label: null,
    action_type: 'ban',
    target_type: null,
    target_id: null,
    status_code: 301, // < 400 → «переход»
    duration_ms: null,
    context: {},
    row_hash: null,
    prev_hash: null,
  },
  {
    id: 'a3',
    created_at: '2026-07-23T10:02:00Z',
    actor_kind: 'system',
    actor_player_id: null,
    actor_token_id: null,
    actor_system_label: 'sync-worker',
    action_type: 'sync',
    target_type: 'server',
    target_id: null,
    status_code: 404, // < 500 → «отказ»
    duration_ms: 0,
    context: {},
  },
  {
    id: 'a4',
    created_at: '2026-07-23T10:03:00Z',
    actor_kind: 'system',
    actor_player_id: null,
    actor_token_id: null,
    actor_system_label: null,
    action_type: 'cleanup',
    target_type: null,
    target_id: null,
    status_code: 500, // >= 500 → «сбой»
    duration_ms: 3,
    context: {},
  },
  {
    id: 'a5',
    created_at: '2026-07-23T10:04:00Z',
    actor_kind: 'system',
    actor_player_id: null,
    actor_token_id: null,
    actor_system_label: null,
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

    // Класс кода ответа назван словом, а не только цветом (StatusCode).
    expect(screen.getByText('201 · успех')).toBeInTheDocument();
    expect(screen.getByText('301 · переход')).toBeInTheDocument();
    expect(screen.getByText('404 · отказ')).toBeInTheDocument();
    expect(screen.getByText('500 · сбой')).toBeInTheDocument();
    // Код, которого нет, остаётся прочерком.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);

    // Actor cell: a steam actor with a resolved player id links to the player
    // card (8-char slice); one without a resolved id (still 'steam') falls
    // back to '—'; a system actor with a label shows it, one without falls
    // back to the bare kind (#484).
    const actorLink = screen.getByRole('link', { name: 'deltause' });
    expect(actorLink).toHaveAttribute('href', '/all-players/deltauser1234567');
    expect(screen.getByText('sync-worker')).toBeInTheDocument();
    expect(screen.getAllByText('system').length).toBeGreaterThanOrEqual(1);

    // Target cell: truthy target_type with sliced id, and '—' fallbacks
    expect(screen.getByText(/beta gamma-id-000/)).toBeInTheDocument();
  });

  it('filters on the action_type operand', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'alpha' },
    });
    // Поле поиска отправляет запрос по паузе в наборе — фильтр применяется
    // не в том же такте, что и ввод.
    await waitFor(() => expect(screen.queryByText('ban')).not.toBeInTheDocument());
    expect(screen.getByText('alpha.action')).toBeInTheDocument();
  });

  it('filters on the target_type operand', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'beta' },
    });
    // Поле поиска отправляет запрос по паузе в наборе — фильтр применяется
    // не в том же такте, что и ввод.
    await waitFor(() => expect(screen.queryByText('cleanup')).not.toBeInTheDocument());
    expect(screen.getByText('alpha.action')).toBeInTheDocument();
  });

  it('filters on the target_id operand', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'gamma' },
    });
    // Поле поиска отправляет запрос по паузе в наборе — фильтр применяется
    // не в том же такте, что и ввод.
    await waitFor(() => expect(screen.queryByText('noop')).not.toBeInTheDocument());
    expect(screen.getByText('alpha.action')).toBeInTheDocument();
  });

  it('filters on the actor_player_id operand', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'deltauser' },
    });
    // Поле поиска отправляет запрос по паузе в наборе — фильтр применяется
    // не в том же такте, что и ввод.
    await waitFor(() => expect(screen.queryByText('sync')).not.toBeInTheDocument());
    expect(screen.getByText('alpha.action')).toBeInTheDocument();
  });

  it('filters on the actor_system_label operand (#484)', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'sync-worker' },
    });
    await waitFor(() => expect(screen.queryByText('cleanup')).not.toBeInTheDocument());
    expect(screen.getByText('sync')).toBeInTheDocument();
  });

  it('shows the no-match empty state when a filter matches nothing', async () => {
    render(<AuditPage />);
    await screen.findByText('alpha.action');
    fireEvent.change(screen.getByPlaceholderText(/Фильтр по действию/), {
      target: { value: 'zzzz-no-match' },
    });
    // Поле поиска отправляет запрос по паузе в наборе — фильтр применяется
    // не в том же такте, что и ввод.
    await waitFor(() => expect(screen.getByText('Нет совпадений.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Сбросить фильтр' })).toBeInTheDocument();
  });

  it('shows the empty-journal state when there are no entries', async () => {
    listItems = [];
    render(<AuditPage />);
    await waitFor(() => expect(screen.getByText('Журнал пуст.')).toBeInTheDocument());
  });

  it('shows a loading skeleton before the first response, not the empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    render(<AuditPage />);

    expect(await screen.findByText('Журнал загружается')).toBeInTheDocument();
    expect(screen.queryByText('Журнал пуст.')).not.toBeInTheDocument();
  });

  it('surfaces a list error and reloads the journal on «Повторить»', async () => {
    let failing = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        failing
          ? Promise.resolve(new Response('nope', { status: 503 }))
          : Promise.resolve(new Response(JSON.stringify({ items: ITEMS }), { status: 200 })),
      ),
    );
    render(<AuditPage />);

    expect(await screen.findByText('Не удалось загрузить журнал')).toBeInTheDocument();

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    await waitFor(() => expect(screen.getByText('alpha.action')).toBeInTheDocument());
  });

  it('expands a row with hashes and collapses it again', async () => {
    render(<AuditPage />);
    const disclosure = await screen.findByRole('button', { name: 'alpha.action' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    // Expand → context + hash detail visible (prev_hash present branch)
    fireEvent.click(disclosure);
    await waitFor(() => expect(document.body.textContent).toContain('r'.repeat(64)));
    expect(document.body.textContent).toContain('p'.repeat(64));
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');

    // Collapse (expanded === r.id ? null : r.id → null branch)
    fireEvent.click(disclosure);
    await waitFor(() => expect(document.body.textContent).not.toContain('r'.repeat(64)));
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands a row without a row_hash (no hash detail block)', async () => {
    render(<AuditPage />);
    const banCell = await screen.findByRole('button', { name: 'ban' });
    fireEvent.click(banCell);
    // Row expands (context shown) but there is no row_hash dl block.
    await waitFor(() => {
      const detail = screen.getByText('{}');
      expect(detail).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain('row_hash:');
  });
});
