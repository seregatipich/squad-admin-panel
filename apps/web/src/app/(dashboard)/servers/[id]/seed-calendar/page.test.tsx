// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOfWeekUtc } from './helpers';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/servers/srv-1/seed-calendar'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import SeedCalendarPage from './page';

// Anchored to the real current week (not a hardcoded date) so the fixtures
// always fall inside the page's default week-grid view, whatever day the
// suite actually runs on.
const WEEK_START = startOfWeekUtc(new Date());
const OCCURRENCE_DAY = new Date(WEEK_START.getTime());
OCCURRENCE_DAY.setUTCDate(OCCURRENCE_DAY.getUTCDate() + 2);

const ENTRIES = [
  {
    id: 'entry-1',
    server_id: 'srv-1',
    starts_at: new Date(OCCURRENCE_DAY.getTime() + 10 * 3_600_000).toISOString(), // day+2, 10:00 UTC
    seed_layer: 'Sumari Seed v1',
    broadcast_text: null,
    recurrence: null,
    enabled: true,
    created_by: null,
    last_executed_at: null,
    created_at: WEEK_START.toISOString(),
    updated_at: WEEK_START.toISOString(),
  },
];

const WINDOWS = [
  {
    started_at: new Date(OCCURRENCE_DAY.getTime() + 8 * 3_600_000).toISOString(), // day+2, 08:00 UTC
    ended_at: new Date(OCCURRENCE_DAY.getTime() + 8.5 * 3_600_000).toISOString(), // day+2, 08:30 UTC
    layer: 'Sumari Seed v1',
    player_count_at_start: 3,
  },
];

const LAYERS_POOL = { rows: [{ name: 'Sumari Seed v1' }, { name: 'Narva Seed v1' }] };

function mockFetch(canEdit: boolean, opts: { fail?: 'list' | 'history' } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/seed-schedule/history')) {
        if (opts.fail === 'history') return Promise.resolve(new Response('boom', { status: 500 }));
        return Promise.resolve(new Response(JSON.stringify({ windows: WINDOWS }), { status: 200 }));
      }
      if (url.endsWith('/seed-schedule')) {
        if (opts.fail === 'list') return Promise.resolve(new Response('boom', { status: 500 }));
        return Promise.resolve(
          new Response(JSON.stringify({ entries: ENTRIES, can_edit: canEdit }), { status: 200 }),
        );
      }
      if (url.startsWith('/api/v1/layers')) {
        return Promise.resolve(new Response(JSON.stringify(LAYERS_POOL), { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }),
  );
}

beforeEach(() => {
  mockFetch(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <SeedCalendarPage params={Promise.resolve({ id: 'srv-1' })} />
      </Suspense>,
    );
  });
}

describe('SeedCalendarPage', () => {
  it('is a valid React component', () => {
    expect(SeedCalendarPage).toBeDefined();
    expect(typeof SeedCalendarPage).toBe('function');
  });

  it('renders the week grid with a planned occurrence and a historical seeding window', async () => {
    await renderPage();
    await screen.findByTestId('week-grid');
    // The layer name appears in both the planned occurrence and the
    // historical window blocks — assert at least one of each is rendered.
    expect(screen.getAllByText(/Sumari Seed v1/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/08:00–08:30/)).toBeInTheDocument();
  });

  it('shows an error message when the entries fetch fails', async () => {
    mockFetch(true, { fail: 'list' });
    await renderPage();
    await screen.findByText(/HTTP 500/);
  });

  it('shows create/edit/delete controls with the changemap permission', async () => {
    await renderPage();
    await screen.findByTestId('week-grid');
    expect(screen.getAllByRole('button', { name: 'Добавить сид-старт' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'удалить' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'выключить' })).toBeInTheDocument();
  });

  it('hides create/edit/delete controls and shows a read-only note without the changemap permission', async () => {
    mockFetch(false);
    await renderPage();
    await screen.findByTestId('week-grid');
    expect(screen.queryByRole('button', { name: 'Добавить сид-старт' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'удалить' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'выключить' })).not.toBeInTheDocument();
    expect(screen.getByText(/Только просмотр/)).toBeInTheDocument();
  });
});
