// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PresenceSection } from './PresenceSection';
import type { PresenceResponse } from './presence';

const TEST_TIMEOUT_MS = 15_000;

function presence(overrides: Partial<PresenceResponse> = {}): PresenceResponse {
  return {
    totals: { online_seconds: 0, boost_seconds: 0, queue_seconds: 0, seed_seconds: 7440 },
    bonus: { formula: 'online + 2×boost', value_seconds: 0 },
    by_server: [
      {
        server_id: 's1',
        server_name: 'Seed Server',
        server_slug: 'seed-srv',
        online_seconds: 0,
        boost_seconds: 0,
        queue_seconds: 0,
        seed_seconds: 7440,
        session_count: 2,
      },
    ],
    sessions: [],
    week: { from: '2026-09-04', to: '2026-09-10' },
    ...overrides,
  };
}

/** Routes the section's own request; the chart and primetime children get a 404. */
function stubFetch(body: PresenceResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        /\/presence$/.test(url)
          ? new Response(JSON.stringify(body), { status: 200 })
          : new Response(null, { status: 404 }),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PresenceSection', () => {
  it(
    'shows time played while seeding in the per-server table instead of 0 online (regression)',
    async () => {
      stubFetch(presence());
      render(<PresenceSection playerId="player-seed" />);

      fireEvent.click(await screen.findByRole('tab', { name: 'По серверам' }));

      const table = within(screen.getByRole('table', { name: 'Присутствие по серверам' }));
      expect(table.getByRole('columnheader', { name: 'Сид' })).toBeInTheDocument();
      const row = table.getByText('seed-srv').closest('tr');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByText('2ч 4м')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows the seed total next to boost and bonuses',
    async () => {
      stubFetch(presence());
      render(<PresenceSection playerId="player-seed" />);

      expect(await screen.findByText(/сек сид-времени/)).toBeInTheDocument();
      expect(screen.getByText('2ч 4м')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
