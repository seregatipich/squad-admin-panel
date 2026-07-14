// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/players/b1e2c3d4-0000-0000-0000-000000000001'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/RoleColorDot', () => ({ RoleColorDot: () => null }));
vi.mock('@/components/PlayerMarks', () => ({ PlayerMarks: () => null }));
vi.mock('./BonusSection', () => ({ BonusSection: () => null }));
vi.mock('./ChatHistorySection', () => ({ ChatHistorySection: () => null }));
vi.mock('./GeoAnomaliesSection', () => ({ GeoAnomaliesSection: () => null }));
vi.mock('./NotesSection', () => ({ NotesSection: () => null }));
vi.mock('./PlayerTeamkillsSection', () => ({ PlayerTeamkillsSection: () => null }));
vi.mock('./PresenceSection', () => ({ PresenceSection: () => null }));
vi.mock('./RecentMatchesSection', () => ({ RecentMatchesSection: () => null }));
vi.mock('./ReportPlayerSection', () => ({ ReportPlayerSection: () => null }));
vi.mock('./ReportsSection', () => ({ ReportsSection: () => null }));
vi.mock('./VotesSection', () => ({ VotesSection: () => null }));

import PlayerDetailPage from './page';

const PLAYER_ID = 'b1e2c3d4-0000-0000-0000-000000000001';

const PLAYER_RESPONSE = {
  player: {
    id: PLAYER_ID,
    steam_id64: '76561198000000001',
    canonical_name: 'CurrentNick',
    eos_id: null,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    total_time_played_seconds: 3600,
  },
  names: [
    {
      name: 'OldNick',
      name_normalized: 'oldnick',
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      observation_count: 2,
    },
  ],
  ips: [],
  locations: [],
  ips_visible: false,
  geo_configured: true,
};

function mockFetch(opts: { canBan: boolean; checkMatched?: boolean }) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === `/api/v1/players/${PLAYER_ID}`) {
      return Promise.resolve(new Response(JSON.stringify(PLAYER_RESPONSE), { status: 200 }));
    }
    if (url === '/api/v1/me') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            player_id: 'me-1',
            permissions: [],
            squad_permissions: opts.canBan ? ['ban'] : [],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.startsWith('/api/v1/whitelist/settings')) {
      return Promise.resolve(
        new Response(JSON.stringify({ whitelist_role_id: null, whitelist_role_name: null }), {
          status: 200,
        }),
      );
    }
    if (url === `/api/v1/players/${PLAYER_ID}/role`) {
      return Promise.resolve(new Response(JSON.stringify({ role: null }), { status: 200 }));
    }
    if (url.startsWith('/api/v1/banned-names/check')) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            opts.checkMatched
              ? {
                  matched: true,
                  rule: {
                    id: 'rule-1',
                    pattern: 'CurrentNick',
                    match_type: 'exact',
                    action: 'kick',
                    reason: null,
                    is_active: true,
                  },
                  can_mutate: opts.canBan,
                }
              : { matched: false, rule: null, can_mutate: opts.canBan },
          ),
          { status: 200 },
        ),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <PlayerDetailPage params={Promise.resolve({ id: PLAYER_ID })} />
      </Suspense>,
    );
  });
}

describe('PlayerDetailPage', () => {
  it('is a valid React component', () => {
    expect(PlayerDetailPage).toBeDefined();
    expect(typeof PlayerDetailPage).toBe('function');
  });

  it('renders the «Ник забанен» badge when the current nick matches an active rule', async () => {
    vi.stubGlobal('fetch', mockFetch({ canBan: true, checkMatched: true }));
    await renderPage();
    expect(await screen.findByText(/ник забанен/i)).toBeInTheDocument();
  });

  it('hides history-row «Забанить ник» buttons without the ban squad permission', async () => {
    vi.stubGlobal('fetch', mockFetch({ canBan: false }));
    await renderPage();
    await screen.findByText('OldNick');
    expect(screen.queryByRole('button', { name: /забанить ник/i })).not.toBeInTheDocument();
  });

  it('a history-row «Забанить ник» button opens the modal prefilled with that historical nick', async () => {
    vi.stubGlobal('fetch', mockFetch({ canBan: true }));
    await renderPage();
    const row = (await screen.findByText('OldNick')).closest('tr');
    if (!row) throw new Error('history row not found');
    const button = within(row).getByRole('button', { name: /забанить ник/i });
    fireEvent.click(button);

    const patternInput = (await screen.findByLabelText(/паттерн/i)) as HTMLInputElement;
    await waitFor(() => expect(patternInput.value).toBe('OldNick'));
  });
});
