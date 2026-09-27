// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/groups/role-1/members'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@squad/shared-config/role-colors', () => ({
  ROLE_COLORS: [],
}));
vi.mock('@/components/RoleColorDot', () => ({
  RoleColorDot: () => null,
}));

import MembersPage from './page';

// Two members: Alpha has a comment + steamid; Beta has neither (exercises the
// `steam_id64 ?? '—'` and `role_comment ?? '—'` fallbacks).
function membersResponse(total = 2) {
  return {
    role: { id: 'role-1', name: 'Admin', color: 'neutral' },
    items: [
      {
        id: 'p1',
        steam_id64: '76561198000000001',
        canonical_name: 'Alpha',
        last_seen_at: '2026-07-20T00:00:00.000Z',
        role_comment: 'основной',
      },
      {
        id: 'p2',
        steam_id64: null,
        canonical_name: 'Beta',
        last_seen_at: '2026-07-21T00:00:00.000Z',
        role_comment: null,
      },
    ],
    total,
    limit: 100,
    offset: 0,
  };
}

const ROLES_RESPONSE = [
  { id: 'role-1', name: 'Admin', color: 'neutral', is_system_role: false }, // self → filtered
  { id: 'role-2', name: 'Moderator', color: 'blue', is_system_role: false }, // kept
  { id: 'role-owner', name: 'Owner', color: 'amber', is_system_role: true }, // Owner → filtered
  { id: 'role-3', name: 'Helper', color: 'green', is_system_role: true }, // system, not Owner → kept
];

const PLAYERS_RESPONSE = {
  items: [
    {
      id: 'p9',
      steam_id64: '76561198000000009',
      canonical_name: 'Newbie',
      last_seen_at: '2026-07-22T00:00:00.000Z',
    },
  ],
};

interface StubResponse {
  status: number;
  body: unknown;
}

// Per-endpoint responses, mutable per test.
let handlers: {
  members: unknown;
  bulkDelete: StubResponse;
  move: StubResponse;
  import: StubResponse;
  add: StubResponse;
  remove: StubResponse;
  export: () => Promise<Response>;
  permissions: string[] | null;
};

let createObjectURLMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function respond({ status, body }: StubResponse) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/v1/me') {
        return handlers.permissions === null
          ? Promise.resolve(new Response('no', { status: 401 }))
          : json({ permissions: handlers.permissions });
      }
      if (url === '/api/v1/roles') {
        return json(ROLES_RESPONSE);
      }
      if (url.startsWith('/api/v1/players')) {
        return json(PLAYERS_RESPONSE);
      }
      if (url.includes('/members/bulk-delete') && method === 'POST') {
        return respond(handlers.bulkDelete);
      }
      if (url.includes('/members/move') && method === 'POST') {
        return respond(handlers.move);
      }
      if (url.includes('/members/import') && method === 'POST') {
        return respond(handlers.import);
      }
      if (url.includes('/members/export')) {
        return handlers.export();
      }
      if (url.match(/\/members\/[^/]+$/) && method === 'DELETE') {
        return respond(handlers.remove);
      }
      if (url.endsWith('/members') && method === 'POST') {
        return respond(handlers.add);
      }
      if (url.includes('/members')) {
        return json(handlers.members);
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

beforeEach(() => {
  handlers = {
    members: membersResponse(),
    bulkDelete: { status: 200, body: { ok: true } },
    move: { status: 200, body: { ok: true } },
    import: { status: 201, body: { ok: true } },
    add: { status: 201, body: { ok: true } },
    remove: { status: 200, body: { ok: true } },
    export: () => Promise.resolve(new Response('steam_id64\n76561198000000001', { status: 200 })),
    permissions: ['user:manage_roles'],
  };
  installFetch();
  // jsdom does not implement object URLs; add just the static helpers exportCsv needs
  // without clobbering the URL constructor.
  createObjectURLMock = vi.fn(() => 'blob:mock');
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURLMock;
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  (URL as unknown as { createObjectURL?: unknown }).createObjectURL = undefined;
  (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = undefined;
});

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <MembersPage params={Promise.resolve({ id: 'role-1' })} />
      </Suspense>,
    );
  });
  await screen.findByText('Alpha');
}

function fetchMock() {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

/** Подтверждает открытый `AlertDialog`: находит окно по имени и жмёт его кнопку. */
async function confirmDialog(dialogName: string, confirmLabel: string) {
  const dialog = await screen.findByRole('dialog', { name: dialogName });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: confirmLabel }));
  });
}

/** Отказывается от открытого `AlertDialog` кнопкой «Отмена». */
async function dismissDialog(dialogName: string) {
  const dialog = await screen.findByRole('dialog', { name: dialogName });
  await act(async () => {
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Отмена' })[0]);
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

function callsMatching(pred: (url: string, init?: RequestInit) => boolean) {
  return fetchMock().mock.calls.filter((c) =>
    pred(typeof c[0] === 'string' ? c[0] : String(c[0]), c[1] as RequestInit | undefined),
  );
}

describe('MembersPage — branch coverage', () => {
  it('renders the null-value fallbacks for members without steamid/comment', async () => {
    await renderPage();
    // Beta has null steam_id64 and null role_comment → both render as '—'.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('selects a member, shows the bulk toolbar, and bulk-deletes on confirm', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Выбрать Alpha' }));

    const toolbar = await screen.findByTestId('bulk-toolbar');
    expect(toolbar).toHaveTextContent('Выбрано: 1');

    fireEvent.click(screen.getByRole('button', { name: 'Удалить выбранных' }));
    await confirmDialog('Снять роль с выбранных', 'Снять роль');

    const del = callsMatching((u, i) => u.includes('/members/bulk-delete') && i?.method === 'POST');
    expect(del.length).toBe(1);
    expect(JSON.parse(del[0][1]?.body as string)).toEqual({ player_ids: ['p1'] });
    // Successful bulk delete reloads and clears the selection → toolbar disappears.
    await waitFor(() => expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument());
  });

  it('surfaces an error when bulk delete fails', async () => {
    handlers.bulkDelete = { status: 500, body: { error: 'bulk_boom' } };
    await renderPage();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Выбрать Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Удалить выбранных' }));
    await confirmDialog('Снять роль с выбранных', 'Снять роль');
    expect(await screen.findByText('Ошибка: bulk_boom')).toBeInTheDocument();
  });

  it('does not bulk-delete when the confirm dialog is dismissed', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Выбрать Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Удалить выбранных' }));
    await dismissDialog('Снять роль с выбранных');
    expect(
      callsMatching((u, i) => u.includes('/members/bulk-delete') && i?.method === 'POST').length,
    ).toBe(0);
  });

  it('toggles the whole page via the header checkbox and back off', async () => {
    await renderPage();
    const headerCheckbox = screen.getByRole('checkbox', { name: 'Выбрать всех на странице' });
    fireEvent.click(headerCheckbox);
    expect(await screen.findByTestId('bulk-toolbar')).toHaveTextContent('Выбрано: 2');
    // Clicking again (all already selected) clears the selection.
    fireEvent.click(headerCheckbox);
    await waitFor(() => expect(screen.queryByTestId('bulk-toolbar')).not.toBeInTheDocument());
  });

  it('opens the move modal, filters roles, and moves the selection', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Выбрать Alpha' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Переместить в роль' }));

    const modal = await screen.findByTestId('move-modal');
    const select = screen.getByRole('combobox', { name: 'Целевая роль' });
    // Self (Admin) and Owner are filtered out; Moderator + Helper remain.
    expect(select).toHaveTextContent('Moderator');
    expect(select).toHaveTextContent('Helper');
    expect(select).not.toHaveTextContent('Owner');
    expect(modal).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'role-2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Переместить' }));
    });

    const moved = callsMatching((u, i) => u.includes('/members/move') && i?.method === 'POST');
    expect(moved.length).toBe(1);
    expect(JSON.parse(moved[0][1]?.body as string)).toEqual({
      player_ids: ['p1'],
      target_role_id: 'role-2',
    });
    await waitFor(() => expect(screen.queryByTestId('move-modal')).not.toBeInTheDocument());
  });

  it('surfaces an error when the move fails', async () => {
    handlers.move = { status: 409, body: { error: 'move_conflict' } };
    await renderPage();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Выбрать Alpha' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Переместить в роль' }));
    const select = await screen.findByRole('combobox', { name: 'Целевая роль' });
    fireEvent.change(select, { target: { value: 'role-2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Переместить' }));
    });
    expect(await screen.findByText('Ошибка перемещения: move_conflict')).toBeInTheDocument();
  });

  it('closes the move modal without moving', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Выбрать Alpha' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Переместить в роль' }));
    await screen.findByTestId('move-modal');
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(screen.queryByTestId('move-modal')).not.toBeInTheDocument());
    expect(
      callsMatching((u, i) => u.includes('/members/move') && i?.method === 'POST').length,
    ).toBe(0);
  });

  it('exports the member list as a CSV download', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Экспорт CSV' }));
    });
    expect(callsMatching((u) => u.includes('/members/export')).length).toBe(1);
    expect(createObjectURLMock.mock.calls.length).toBe(1);
  });

  it('surfaces an error when the export request fails', async () => {
    handlers.export = () => Promise.resolve(new Response('nope', { status: 500 }));
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Экспорт CSV' }));
    });
    expect(await screen.findByText('Ошибка экспорта: 500')).toBeInTheDocument();
  });

  it('removes a single member on confirm', async () => {
    await renderPage();
    const removeButtons = screen.getAllByRole('button', { name: 'Снять' });
    fireEvent.click(removeButtons[0]);
    await confirmDialog('Снять роль', 'Снять роль');
    const del = callsMatching((u, i) => /\/members\/p1$/.test(u) && i?.method === 'DELETE');
    expect(del.length).toBe(1);
  });

  it('surfaces an error when removing a single member fails', async () => {
    handlers.remove = { status: 403, body: { error: 'forbidden' } };
    await renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Снять' })[0]);
    await confirmDialog('Снять роль', 'Снять роль');
    expect(await screen.findByText('Ошибка: forbidden')).toBeInTheDocument();
  });

  it('does not remove when confirm is dismissed', async () => {
    await renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: 'Снять' })[0]);
    await dismissDialog('Снять роль');
    expect(callsMatching((u, i) => /\/members\/p1$/.test(u) && i?.method === 'DELETE').length).toBe(
      0,
    );
  });

  it('shows the top-level import error for a non-validation failure', async () => {
    handlers.import = { status: 500, body: { error: 'import_server_error' } };
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Импорт CSV' }));
    const textarea = await screen.findByTestId('import-textarea');
    fireEvent.change(textarea, { target: { value: '76561198000000001' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Импортировать' }));
    });
    expect(await screen.findByText('Ошибка: import_server_error')).toBeInTheDocument();
    // Non-422 error keeps the modal open.
    expect(screen.getByTestId('import-modal')).toBeInTheDocument();
  });

  it('closes the import modal via the cancel button', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Импорт CSV' }));
    await screen.findByTestId('import-modal');
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByTestId('import-modal')).not.toBeInTheDocument());
  });

  it('paginates to the next page and enables the previous button', async () => {
    handlers.members = membersResponse(150); // total > PAGE_SIZE → "след." enabled
    await renderPage();
    expect(screen.getByText('Страница 1 из 2')).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Вперёд' });
    expect(next).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(next);
    });
    expect(await screen.findByText('Страница 2 из 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Назад' })).not.toBeDisabled();
    // The reload requested offset=100.
    expect(callsMatching((u) => u.includes('offset=100')).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the empty state when the role has no members', async () => {
    handlers.members = {
      role: { id: 'role-1', name: 'Admin', color: 'neutral' },
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    };
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <MembersPage params={Promise.resolve({ id: 'role-1' })} />
        </Suspense>,
      );
    });
    expect(await screen.findByText('Нет участников')).toBeInTheDocument();
  });

  it('searches for a player in the add modal and assigns them', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить игрока' }));
    const input = await screen.findByPlaceholderText('Ник или SteamID64…');
    fireEvent.change(input, { target: { value: 'New' } });
    // Debounced search fires after 250ms.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });
    const assign = await screen.findByRole('button', { name: 'Назначить' });
    await act(async () => {
      fireEvent.click(assign);
    });
    const add = callsMatching((u, i) => u.endsWith('/members') && i?.method === 'POST');
    expect(add.length).toBe(1);
    expect(JSON.parse(add[0][1]?.body as string)).toEqual({ player_id: 'p9' });
  });

  it('surfaces an error when adding a player fails', async () => {
    handlers.add = { status: 409, body: { error: 'already_member' } };
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить игрока' }));
    const input = await screen.findByPlaceholderText('Ник или SteamID64…');
    fireEvent.change(input, { target: { value: 'New' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Назначить' }));
    });
    expect(await screen.findByText('Ошибка: already_member')).toBeInTheDocument();
  });

  it('hides management controls for users without manage_roles', async () => {
    handlers.permissions = ['user:view'];
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Импорт CSV' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Добавить игрока' })).not.toBeInTheDocument();
    // Export stays available to everyone.
    expect(screen.getByRole('button', { name: 'Экспорт CSV' })).toBeInTheDocument();
  });

  it('renders the error view when the members request fails', async () => {
    handlers.members = membersResponse();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        const url = String(input);
        if (url.includes('/members')) {
          return Promise.resolve(new Response('boom', { status: 503 }));
        }
        if (url === '/api/v1/me') return json({ permissions: ['user:manage_roles'] });
        if (url === '/api/v1/roles') return json(ROLES_RESPONSE);
        return Promise.resolve(new Response('nf', { status: 404 }));
      }),
    );
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <MembersPage params={Promise.resolve({ id: 'role-1' })} />
        </Suspense>,
      );
    });
    expect(await screen.findByText('HTTP 503')).toBeInTheDocument();
  });
});
