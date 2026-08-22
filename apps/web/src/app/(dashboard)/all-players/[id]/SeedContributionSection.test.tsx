// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SeedContributionSection } from './SeedContributionSection';
import type { SeedContributionResponse } from './seed-contribution';

const TEST_TIMEOUT_MS = 15_000;

function payload(overrides: Partial<SeedContributionResponse> = {}): SeedContributionResponse {
  return {
    window: { from: '2026-06-15', to: '2026-07-14', days: 30 },
    total_seed_seconds: 3661,
    by_server: [
      { server_id: 's1', server_name: 'Server One', server_slug: 'srv-1', seed_seconds: 3661 },
    ],
    series: [{ day: '2026-07-14', seed_seconds: 3661 }],
    bonus: { k_seed: 3, earned_points: 10 },
    ...overrides,
  };
}

function stubFetch(status: number, body?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response(body !== undefined ? JSON.stringify(body) : null, { status })),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SeedContributionSection', () => {
  it(
    'renders the headline and per-server breakdown from the fetched data',
    async () => {
      stubFetch(200, payload());
      render(<SeedContributionSection playerId="player-alpha" />);

      await screen.findByRole('heading', { name: 'Сид-вклад' });
      expect(screen.getByText('Сид за 30 дней')).toBeInTheDocument();
      // Одна и та же длительность стоит и в плитке итога, и в строке сервера.
      expect(screen.getAllByText('1ч 1м')).toHaveLength(2);
      const serverRow = within(screen.getByRole('table'));
      expect(serverRow.getByText('srv-1')).toBeInTheDocument();
      expect(serverRow.getByText('1ч 1м')).toBeInTheDocument();
      expect(screen.getByText('Бонусы за сид')).toBeInTheDocument();
      expect(screen.getByText('10')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the API responds with 401',
    async () => {
      stubFetch(401);
      const { container } = render(<SeedContributionSection playerId="player-alpha" />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the API responds with 403',
    async () => {
      stubFetch(403);
      const { container } = render(<SeedContributionSection playerId="player-alpha" />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an error state on a 500 response',
    async () => {
      stubFetch(500);
      render(<SeedContributionSection playerId="player-alpha" />);

      await screen.findByText('Не удалось загрузить сид-вклад');
      expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an empty state when the player has no per-server presence',
    async () => {
      stubFetch(200, payload({ by_server: [], total_seed_seconds: 0 }));
      render(<SeedContributionSection playerId="player-alpha" />);

      await screen.findByText('Нет данных о сид-вкладе по серверам.');
      expect(screen.getByText('0ч 0м')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
