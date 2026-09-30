// @vitest-environment happy-dom
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
vi.mock('@/components/DossierSection', () => ({ DossierSection: () => null }));
vi.mock('./GeoAnomaliesSection', () => ({ GeoAnomaliesSection: () => null }));
vi.mock('./NotesSection', () => ({ NotesSection: () => null }));
vi.mock('./PlayerTeamkillsSection', () => ({ PlayerTeamkillsSection: () => null }));
vi.mock('./PresenceSection', () => ({ PresenceSection: () => null }));
vi.mock('@/components/RecentMatchesSection', () => ({ RecentMatchesSection: () => null }));
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

interface MockRole {
  id: string;
  name: string;
  color: string;
  is_system_role: boolean;
  role_expires_at: string | null;
  role_comment: string | null;
}

function mockFetch(opts: {
  canBan: boolean;
  canManageRoles?: boolean;
  canEditWhitelist?: boolean;
  whitelistRole?: { id: string; name: string };
  currentRole?: MockRole;
  checkMatched?: boolean;
  player?: Partial<(typeof PLAYER_RESPONSE)['player']>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/v1/whitelist/members' && init?.method === 'POST') {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, changed: true }), { status: 201 }),
      );
    }
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
            permissions: [
              ...(opts.canManageRoles ? ['user:manage_roles'] : []),
              ...(opts.canEditWhitelist ? ['whitelist:edit'] : []),
            ],
            squad_permissions: opts.canBan ? ['ban'] : [],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.startsWith('/api/v1/whitelist/settings')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            whitelist_role_id: opts.whitelistRole?.id ?? null,
            whitelist_role_name: opts.whitelistRole?.name ?? null,
          }),
          { status: 200 },
        ),
      );
    }
    if (url === `/api/v1/players/${PLAYER_ID}/role`) {
      return Promise.resolve(
        new Response(JSON.stringify({ role: opts.currentRole ?? null }), { status: 200 }),
      );
    }
    if (url === '/api/v1/roles') {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 'role-admin',
              name: 'Admin',
              color: 'sky',
              is_system_role: false,
              role_expires_at: null,
              role_comment: null,
            },
          ]),
          { status: 200 },
        ),
      );
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
  // Regression (#472): a decoded route id reached API paths unchecked.
  it('refuses a route id that is not a UUID without calling the API', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <PlayerDetailPage params={Promise.resolve({ id: '../../api/v1/players/x?' })} />
        </Suspense>,
      );
    });

    expect(await screen.findByText('Некорректный идентификатор игрока')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

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

  it('uses the same explained date-only picker in the player role editor', async () => {
    vi.stubGlobal('fetch', mockFetch({ canBan: false, canManageRoles: true }));
    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Выдать роль' }));

    expect(
      screen.getByRole('button', { name: 'Открыть календарь срока действия' }),
    ).toHaveTextContent('ДД/ММ/ГГГГ');
    expect(screen.getByPlaceholderText('Например: VIP по заявке')).toHaveAccessibleDescription(
      /причина выдачи видна другим администраторам/i,
    );
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  describe('whitelist quick action (#8)', () => {
    const WHITELIST_ROLE = { id: 'role-wl', name: 'Whitelist' };
    const ADMIN_ROLE: MockRole = {
      id: 'role-admin',
      name: 'Admin',
      color: 'sky',
      is_system_role: false,
      role_expires_at: null,
      role_comment: null,
    };
    const OWNER_ROLE: MockRole = {
      ...ADMIN_ROLE,
      id: 'role-owner',
      name: 'Owner',
      is_system_role: true,
    };

    async function whitelistCard(): Promise<HTMLElement> {
      const title = await screen.findByText('Whitelist');
      const card = title.closest('section');
      if (!card) throw new Error('whitelist card not found');
      return card;
    }

    function memberPosts(fetchMock: ReturnType<typeof mockFetch>) {
      return fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/v1/whitelist/members' && init?.method === 'POST',
      );
    }

    it('offers «В whitelist» for a roleless player and adds them in one click', async () => {
      const fetchMock = mockFetch({
        canBan: false,
        canEditWhitelist: true,
        whitelistRole: WHITELIST_ROLE,
      });
      vi.stubGlobal('fetch', fetchMock);
      await renderPage();
      const card = await whitelistCard();

      await act(async () => {
        fireEvent.click(await within(card).findByRole('button', { name: 'В whitelist' }));
      });

      await waitFor(() => expect(memberPosts(fetchMock)).toHaveLength(1));
    });

    it('hides «В whitelist» for a player with another role when the viewer cannot manage roles', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          canBan: false,
          canEditWhitelist: true,
          whitelistRole: WHITELIST_ROLE,
          currentRole: ADMIN_ROLE,
        }),
      );
      await renderPage();
      const card = await whitelistCard();

      expect(
        await within(card).findByText(/у него роль «Admin»\. Заменить её может только/),
      ).toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: 'В whitelist' })).toBeNull();
    });

    it('never offers «В whitelist» for an Owner, even to a role manager', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({
          canBan: false,
          canManageRoles: true,
          canEditWhitelist: true,
          whitelistRole: WHITELIST_ROLE,
          currentRole: OWNER_ROLE,
        }),
      );
      await renderPage();
      const card = await whitelistCard();

      expect(
        await within(card).findByText(/у него роль «Owner», её нельзя заменить через whitelist/),
      ).toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: 'В whitelist' })).toBeNull();
    });

    it('asks a role manager to confirm replacing the named role before adding', async () => {
      const fetchMock = mockFetch({
        canBan: false,
        canManageRoles: true,
        canEditWhitelist: true,
        whitelistRole: WHITELIST_ROLE,
        currentRole: ADMIN_ROLE,
      });
      vi.stubGlobal('fetch', fetchMock);
      await renderPage();
      const card = await whitelistCard();

      await act(async () => {
        fireEvent.click(await within(card).findByRole('button', { name: 'В whitelist' }));
      });
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(/Роль «Admin» будет заменена ролью whitelist/),
      ).toBeInTheDocument();
      expect(memberPosts(fetchMock)).toHaveLength(0);

      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Заменить роль' }));
      });
      await waitFor(() => expect(memberPosts(fetchMock)).toHaveLength(1));
    });

    it('refreshes the "Роль" card the moment whitelist membership changes it, without a page reload (#477)', async () => {
      let role: MockRole | null = ADMIN_ROLE;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === '/api/v1/whitelist/members' && init?.method === 'POST') {
          role = {
            ...WHITELIST_ROLE,
            color: 'sky',
            is_system_role: false,
            role_expires_at: null,
            role_comment: null,
          };
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true, changed: true }), { status: 201 }),
          );
        }
        if (url === `/api/v1/players/${PLAYER_ID}`) {
          return Promise.resolve(new Response(JSON.stringify(PLAYER_RESPONSE), { status: 200 }));
        }
        if (url === '/api/v1/me') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                player_id: 'me-1',
                permissions: ['user:manage_roles', 'whitelist:edit'],
                squad_permissions: [],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.startsWith('/api/v1/whitelist/settings')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                whitelist_role_id: WHITELIST_ROLE.id,
                whitelist_role_name: WHITELIST_ROLE.name,
              }),
              { status: 200 },
            ),
          );
        }
        if (url === `/api/v1/players/${PLAYER_ID}/role`) {
          return Promise.resolve(new Response(JSON.stringify({ role }), { status: 200 }));
        }
        if (url === '/api/v1/roles') {
          return Promise.resolve(new Response(JSON.stringify([ADMIN_ROLE]), { status: 200 }));
        }
        if (url.startsWith('/api/v1/banned-names/check')) {
          return Promise.resolve(
            new Response(JSON.stringify({ matched: false, rule: null, can_mutate: false }), {
              status: 200,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      });
      vi.stubGlobal('fetch', fetchMock);
      await renderPage();

      const roleCardBefore = (await screen.findByText('Роль')).closest('section');
      if (!roleCardBefore) throw new Error('role card not found');
      expect(within(roleCardBefore).getByText('Admin')).toBeInTheDocument();

      const card = await whitelistCard();
      await act(async () => {
        fireEvent.click(await within(card).findByRole('button', { name: 'В whitelist' }));
      });
      const dialog = await screen.findByRole('dialog');
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Заменить роль' }));
      });

      const roleCardAfter = (await screen.findByText('Роль')).closest('section');
      if (!roleCardAfter) throw new Error('role card not found');
      await waitFor(() => expect(within(roleCardAfter).getByText('Whitelist')).toBeInTheDocument());
      expect(within(roleCardAfter).queryByText('Admin')).not.toBeInTheDocument();
    }, 15_000);
  });
});
