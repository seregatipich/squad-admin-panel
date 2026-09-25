// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const MEMBERS_RESPONSE = {
  role: { id: 'role-1', name: 'Admin', color: 'neutral' },
  items: [
    {
      id: 'p1',
      steam_id64: '76561198000000001',
      canonical_name: 'Alpha',
      last_seen_at: '2026-07-20T00:00:00.000Z',
      role_comment: 'основной',
    },
  ],
  total: 1,
  limit: 100,
  offset: 0,
};

const ROLES_RESPONSE = [
  { id: 'role-1', name: 'Admin', color: 'neutral', is_system_role: false },
  { id: 'role-2', name: 'Moderator', color: 'blue', is_system_role: false },
];

// Import POST response is swappable per test.
let importResponse: { status: number; body: unknown } = { status: 201, body: { ok: true } };

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ permissions: ['user:manage_roles'] }), { status: 200 }),
        );
      }
      if (url === '/api/v1/roles') {
        return Promise.resolve(new Response(JSON.stringify(ROLES_RESPONSE), { status: 200 }));
      }
      if (url.includes('/members/import') && method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify(importResponse.body), { status: importResponse.status }),
        );
      }
      if (url.includes('/members')) {
        return Promise.resolve(new Response(JSON.stringify(MEMBERS_RESPONSE), { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

beforeEach(() => {
  importResponse = { status: 201, body: { ok: true, imported: 1 } };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <MembersPage params={Promise.resolve({ id: 'role-1' })} />
      </Suspense>,
    );
  });
}

describe('MembersPage', () => {
  it('is a valid React component', () => {
    expect(MembersPage).toBeDefined();
    expect(typeof MembersPage).toBe('function');
  });

  it('renders the per-assignment comment column', async () => {
    await renderPage();
    await screen.findByText('Alpha');
    expect(screen.getByText('основной')).toBeInTheDocument();
  });

  it('opens the CSV import modal and posts the textarea contents', async () => {
    await renderPage();
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Импорт CSV' }));
    const textarea = await screen.findByTestId('import-textarea');
    fireEvent.change(textarea, { target: { value: '76561198000000005;новый' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Импортировать' }));
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const importCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('/members/import'),
    );
    expect(importCall).toBeDefined();
    expect(JSON.parse(importCall?.[1].body as string)).toEqual({ csv: '76561198000000005;новый' });
    // On success (201) the modal closes.
    await waitFor(() => expect(screen.queryByTestId('import-modal')).not.toBeInTheDocument());
  });

  it('shows per-row errors and imports nothing when the file is rejected (422)', async () => {
    importResponse = {
      status: 422,
      body: {
        error: 'validation_failed',
        imported: 0,
        errors: [{ line: 2, steam_id64: '76561198000000009', reason: 'player_not_found' }],
      },
    };
    await renderPage();
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Импорт CSV' }));
    const textarea = await screen.findByTestId('import-textarea');
    fireEvent.change(textarea, {
      target: { value: '76561198000000001\n76561198000000009' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Импортировать' }));
    });

    const errorBox = await screen.findByTestId('import-errors');
    expect(errorBox).toHaveTextContent('Строка 2');
    expect(errorBox).toHaveTextContent('игрок не найден в базе');
    // The modal stays open so the operator can fix the file.
    expect(screen.getByTestId('import-modal')).toBeInTheDocument();
  });
});
