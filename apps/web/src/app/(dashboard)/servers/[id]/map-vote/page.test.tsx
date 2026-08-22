// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/srv-1/map-vote'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import MapVotePage from './page';

const STATE = {
  enabled: true,
  selection: 'weighted_random',
  layer_cooldown: 3,
  map_cooldown: 2,
  broadcast_template: null,
  can_edit: true,
  candidates: [
    {
      id: 'c1',
      layer: 'Yehorivka RAAS v11',
      map: 'Yehorivka',
      gamemode: 'RAAS',
      weight: 3,
      enabled: true,
      deprecated: false,
    },
    {
      id: 'c2',
      layer: 'Gorodok RAAS v1',
      map: 'Gorodok',
      gamemode: 'RAAS',
      weight: 1,
      enabled: true,
      deprecated: false,
    },
  ],
};

const PREVIEW = {
  eligible: [
    { layer: 'Yehorivka RAAS v11', weight: 3, probability: 0.75 },
    { layer: 'Gorodok RAAS v1', weight: 1, probability: 0.25 },
  ],
  excluded: [],
  would_pick: 'Yehorivka RAAS v11',
};

const PICKS = {
  picks: [
    {
      id: 'p1',
      match_id: 'm1',
      layer: 'Gorodok RAAS v1',
      selection: 'weighted_random',
      applied: true,
      failure_reason: null,
      created_at: '2026-07-20T10:00:00.000Z',
    },
  ],
};

const LAYERS_POOL = {
  rows: [
    { id: 'l1', name: 'Yehorivka RAAS v11', map: 'Yehorivka', gamemode: 'RAAS', deprecated: false },
    { id: 'l2', name: 'Gorodok RAAS v1', map: 'Gorodok', gamemode: 'RAAS', deprecated: false },
    { id: 'l3', name: 'Narva Skirmish v1', map: 'Narva', gamemode: 'Skirmish', deprecated: false },
  ],
};

function mockFetch(squadPermissions: string[] = ['changemap']) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ squad_permissions: squadPermissions }), { status: 200 }),
        );
      }
      if (url === '/api/v1/layers') {
        return Promise.resolve(new Response(JSON.stringify(LAYERS_POOL), { status: 200 }));
      }
      if (url.includes('/map-vote/preview')) {
        return Promise.resolve(new Response(JSON.stringify(PREVIEW), { status: 200 }));
      }
      if (url.includes('/map-vote/picks')) {
        return Promise.resolve(new Response(JSON.stringify(PICKS), { status: 200 }));
      }
      if (url.endsWith('/map-vote') && (!init || init.method === undefined)) {
        return Promise.resolve(new Response(JSON.stringify(STATE), { status: 200 }));
      }
      if (init?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

beforeEach(() => {
  mockFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <MapVotePage params={Promise.resolve({ id: 'srv-1' })} />
      </Suspense>,
    );
  });
}

/**
 * Кандидат ищется внутри собственного списка, а не по строке CSS-классов:
 * имя слоя встречается ещё в предпросмотре, в истории и в каталоге, и привязка
 * к оформлению ломалась бы от любой смены вёрстки.
 */
async function findCandidate(layer: string) {
  return within(await screen.findByTestId('candidates-list')).findByText(layer);
}

function findPutCall(urlPart: string): [string, RequestInit] | undefined {
  const calls = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
  return calls.find((call) => call[0].includes(urlPart) && call[1] && call[1].method === 'PUT') as
    | [string, RequestInit]
    | undefined;
}

describe('MapVotePage', () => {
  it('renders candidates and saves settings', async () => {
    await renderPage();
    await findCandidate('Yehorivka RAAS v11');
    expect(screen.getByTestId('candidates-list')).toHaveTextContent('Gorodok RAAS v1');
    expect(screen.getByTestId('preview-eligible')).toHaveTextContent('75%');
    expect(screen.getByTestId('picks-list')).toHaveTextContent('Gorodok RAAS v1');

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));

    await waitFor(() => {
      expect(findPutCall('/map-vote/settings')).toBeDefined();
    });
    const putCall = findPutCall('/map-vote/settings');
    const body = JSON.parse(putCall?.[1].body as string);
    expect(body).toEqual({
      enabled: true,
      selection: 'weighted_random',
      layer_cooldown: 3,
      map_cooldown: 2,
      broadcast_template: null,
    });
  });

  it('shows validation error for weight out of range', async () => {
    await renderPage();
    await findCandidate('Yehorivka RAAS v11');

    fireEvent.change(screen.getByLabelText('Вес Yehorivka RAAS v11'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить кандидатов' }));

    expect(await screen.findByText(/от 1 до 100/)).toBeInTheDocument();
    expect(findPutCall('/map-vote/candidates')).toBeUndefined();
  });

  it('hides mutating controls without the changemap permission', async () => {
    mockFetch([]);
    await renderPage();
    await findCandidate('Yehorivka RAAS v11');
    expect(screen.queryByRole('button', { name: 'Сохранить настройки' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сохранить кандидатов' })).not.toBeInTheDocument();
    expect(screen.getByText(/Только просмотр/)).toBeInTheDocument();
  });

  it('saves the candidate list after adding a layer from the catalog', async () => {
    await renderPage();
    await findCandidate('Yehorivka RAAS v11');

    fireEvent.change(screen.getByLabelText('Слой из каталога'), {
      target: { value: 'Narva Skirmish v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить слой' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить кандидатов' }));

    await waitFor(() => {
      expect(findPutCall('/map-vote/candidates')).toBeDefined();
    });
    const putCall = findPutCall('/map-vote/candidates');
    const body = JSON.parse(putCall?.[1].body as string);
    expect(body.candidates).toEqual([
      { layer: 'Yehorivka RAAS v11', weight: 3, enabled: true },
      { layer: 'Gorodok RAAS v1', weight: 1, enabled: true },
      { layer: 'Narva Skirmish v1', weight: 1, enabled: true },
    ]);
  });
});
