// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/srv-1/rotation'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import RotationPage from './page';

const ROTATION_ENTRIES = [
  {
    layer: 'Yehorivka RAAS v11',
    known: true,
    map: 'Yehorivka',
    gamemode: 'RAAS',
    version: 'v11',
    is_seed: false,
    deprecated: false,
  },
  {
    layer: 'Custom_Layer_v9',
    known: false,
    map: null,
    gamemode: null,
    version: null,
    is_seed: null,
    deprecated: null,
  },
];

const LAYERS_POOL = {
  rows: [
    {
      id: 'l1',
      name: 'Yehorivka RAAS v11',
      map: 'Yehorivka',
      gamemode: 'RAAS',
      version: 'v11',
      is_seed: false,
      deprecated: false,
    },
    {
      id: 'l2',
      name: 'Gorodok RAAS v1',
      map: 'Gorodok',
      gamemode: 'RAAS',
      version: 'v1',
      is_seed: false,
      deprecated: false,
    },
  ],
};

function mockFetch(canEdit: boolean, squadPermissions: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ squad_permissions: squadPermissions }), { status: 200 }),
        );
      }
      if (url.endsWith('/rotation')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              file_exists: true,
              has_managed_segment: true,
              entries: ROTATION_ENTRIES,
              behavior: 'rotation',
              can_edit: canEdit,
            }),
            { status: 200 },
          ),
        );
      }
      if (url === '/api/v1/layers') {
        return Promise.resolve(new Response(JSON.stringify(LAYERS_POOL), { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

beforeEach(() => {
  mockFetch(true, ['changemap']);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <RotationPage params={Promise.resolve({ id: 'srv-1' })} />
      </Suspense>,
    );
  });
}

describe('RotationPage', () => {
  it('is a valid React component', () => {
    expect(RotationPage).toBeDefined();
    expect(typeof RotationPage).toBe('function');
  });

  it('renders fetched rotation entries in order with map/gamemode chips', async () => {
    await renderPage();
    await screen.findByText('Yehorivka RAAS v11');
    const list = screen.getByTestId('rotation-list');
    const items = list.querySelectorAll('li');
    expect(items[0]).toHaveTextContent('Yehorivka RAAS v11');
    expect(items[0]).toHaveTextContent('Yehorivka');
    expect(items[0]).toHaveTextContent('RAAS');
    expect(items[1]).toHaveTextContent('Custom_Layer_v9');
  });

  it('shows the unknown-layer badge for a catalog-unknown entry', async () => {
    await renderPage();
    await screen.findByText('Custom_Layer_v9');
    expect(screen.getByText('Нет в каталоге слоёв')).toBeInTheDocument();
  });

  it('shows Сохранить/Добавить слой/Удалить with the changemap permission', async () => {
    await renderPage();
    await screen.findByText('Yehorivka RAAS v11');
    expect(screen.getByRole('button', { name: 'Добавить слой' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Удалить' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Сохранить/ })).toBeInTheDocument();
  });

  it('hides mutating controls and shows a read-only note without the changemap permission', async () => {
    mockFetch(false, []);
    await renderPage();
    await screen.findByText('Yehorivka RAAS v11');
    expect(screen.queryByRole('button', { name: 'Добавить слой' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Удалить' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Сохранить/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Только просмотр/)).toBeInTheDocument();
    const list = screen.getByTestId('rotation-list');
    const items = list.querySelectorAll('li');
    for (const item of items) {
      expect(item).toHaveAttribute('draggable', 'false');
    }
  });

  it('sends the reordered layer names as the PUT payload', async () => {
    await renderPage();
    await screen.findByText('Custom_Layer_v9');

    const downButtons = screen.getAllByRole('button', { name: 'Переместить вниз' });
    // biome-ignore lint/style/noNonNullAssertion: first row's down button always exists here
    downButtons[0]!.click();

    const saveButton = await screen.findByRole('button', { name: /Сохранить/ });
    expect(saveButton).not.toBeDisabled();
    saveButton.click();

    await waitFor(() => {
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const putCall = calls.find((call) => call[1] && (call[1] as RequestInit).method === 'PUT');
      expect(putCall).toBeDefined();
    });

    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const putCall = calls.find((call) => call[1] && (call[1] as RequestInit).method === 'PUT');
    const body = JSON.parse((putCall?.[1] as RequestInit).body as string) as { layers: string[] };
    expect(body.layers).toEqual(['Custom_Layer_v9', 'Yehorivka RAAS v11']);
  });
});
