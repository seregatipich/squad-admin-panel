// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/all-players/b1e2c3d4-0000-0000-0000-000000000001'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/RoleColorDot', () => ({ RoleColorDot: () => null }));
vi.mock('@/components/PlayerMarks', () => ({ PlayerMarks: () => null }));
vi.mock('./BonusSection', () => ({ BonusSection: () => null }));
vi.mock('./ChatHistorySection', () => ({ ChatHistorySection: () => null }));
vi.mock('./DossierSection', () => ({ DossierSection: () => null }));
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
const EOS_ID = '0002a1b2c3d4e5f60708090a0b0c0d0e';

const PLAYER_RESPONSE = {
  player: {
    id: PLAYER_ID,
    steam_id64: '76561198000000001' as string | null,
    canonical_name: 'CurrentNick',
    eos_id: null as string | null,
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

function mockFetch(opts: {
  canBan: boolean;
  checkMatched?: boolean;
  player?: Partial<(typeof PLAYER_RESPONSE)['player']>;
}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === `/api/v1/players/${PLAYER_ID}`) {
      const body = opts.player
        ? { ...PLAYER_RESPONSE, player: { ...PLAYER_RESPONSE.player, ...opts.player } }
        : PLAYER_RESPONSE;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
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

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

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

  it('renders EOS copy button when eos_id is set and copies on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    vi.stubGlobal('fetch', mockFetch({ canBan: false, player: { eos_id: EOS_ID } }));
    await renderPage();

    const button = await screen.findByRole('button', { name: /скопировать/i });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(EOS_ID);
    expect(await screen.findByText(/скопировано/i)).toBeInTheDocument();
  });

  it('hides EOS copy button when eos_id is null', async () => {
    vi.stubGlobal('fetch', mockFetch({ canBan: false }));
    await renderPage();
    await screen.findByText('OldNick');
    expect(screen.queryByRole('button', { name: /скопировать/i })).not.toBeInTheDocument();
  });

  it('renders initials avatar in the header', async () => {
    vi.stubGlobal('fetch', mockFetch({ canBan: false, player: { canonical_name: 'Test Player' } }));
    await renderPage();
    const avatar = await screen.findByTestId('player-avatar');
    expect(avatar).toHaveTextContent('TP');
  });

  it('EOS-only player renders without Steam link and with working copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    vi.stubGlobal(
      'fetch',
      mockFetch({ canBan: false, player: { steam_id64: null, eos_id: EOS_ID } }),
    );
    await renderPage();

    const button = await screen.findByRole('button', { name: /скопировать/i });
    expect(document.querySelector('a[href*="steamcommunity.com"]')).toBeNull();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(EOS_ID);
  });
});
