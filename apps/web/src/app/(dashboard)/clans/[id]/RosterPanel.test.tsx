// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import RosterPanel from './RosterPanel';
import { RosterRow } from './RosterRow';
import {
  deriveCapabilities,
  formatMemberDate,
  formatOnlineDuration,
  memberRoleLabel,
  priorityErrorMessage,
  type RosterMember,
  transferLeadershipMessage,
} from './roster-model';

function member(overrides: Partial<RosterMember> = {}): RosterMember {
  return {
    player_id: overrides.player_id ?? 'p-leader',
    canonical_name: overrides.canonical_name ?? 'Командир',
    steam_id64: overrides.steam_id64 ?? '76561198000000001',
    eos_id: overrides.eos_id ?? null,
    member_role: overrides.member_role ?? 'leader',
    has_priority: overrides.has_priority ?? true,
    reserve_from_role: overrides.reserve_from_role ?? false,
    joined_at: overrides.joined_at ?? '2026-01-01T00:00:00.000Z',
    last_seen_at: overrides.last_seen_at ?? '2026-07-01T12:00:00.000Z',
    online_60d_seconds: overrides.online_60d_seconds ?? 7200,
  };
}

const noop = () => {};
const noopToggle = () => {};

describe('RosterPanel helpers', () => {
  it('formats online duration in hours and minutes', () => {
    expect(formatOnlineDuration(7200)).toBe('2 ч');
    expect(formatOnlineDuration(1800)).toBe('30 мин');
    expect(formatOnlineDuration(0)).toBe('—');
    expect(formatOnlineDuration(-5)).toBe('—');
  });

  it('formats member dates and handles null', () => {
    expect(formatMemberDate(null)).toBe('—');
    expect(formatMemberDate('not-a-date')).toBe('—');
    expect(formatMemberDate('2026-07-01T12:00:00.000Z')).not.toBe('—');
  });

  it('labels roles in Russian', () => {
    expect(memberRoleLabel('leader')).toBe('Глава');
    expect(memberRoleLabel('deputy')).toBe('Зам');
    expect(memberRoleLabel('member')).toBe('Участник');
    expect(memberRoleLabel('unknown')).toBe('unknown');
  });
});

describe('transferLeadershipMessage', () => {
  it('tells the viewer they will be demoted only when they are the leader', () => {
    expect(transferLeadershipMessage(true, 'Ветеран')).toBe(
      'Ветеран станет главой клана, а вы — заместителем.',
    );
  });

  it('never claims an admin without a clan role will be demoted', () => {
    // Regression for #513: an admin with can_manage_clans who is not a
    // clan member must not be told that *they* become deputy — the server
    // demotes the current leader, not the viewer.
    expect(transferLeadershipMessage(false, 'Ветеран')).toBe(
      'Ветеран станет главой клана. Текущий глава станет заместителем.',
    );
  });
});

describe('priorityErrorMessage', () => {
  it('renders the pool-limit message with usage numbers when present', () => {
    expect(priorityErrorMessage({ error: 'priority_pool_limit', used: 5, limit: 5 })).toBe(
      'Лимит пула приоритетов исчерпан (5 из 5)',
    );
  });

  it('falls back to a fixed pool-limit message without usage numbers', () => {
    expect(priorityErrorMessage({ error: 'priority_pool_limit' })).toBe(
      'Лимит пула приоритетов исчерпан',
    );
  });

  it('renders the expiry message', () => {
    expect(priorityErrorMessage({ error: 'priority_expired' })).toBe('Срок приоритета клана истёк');
  });

  it('renders the source-conflict message', () => {
    expect(priorityErrorMessage({ error: 'priority_source_conflict' })).toBe(
      'Приоритет уже предоставлен через роль игрока',
    );
  });

  it('falls back to a generic message for unknown codes', () => {
    expect(priorityErrorMessage({ error: 'something_else' })).toContain('something_else');
  });
});

describe('deriveCapabilities', () => {
  it('grants full control to a global clan manager', () => {
    const caps = deriveCapabilities({ player_id: 'p-outsider', can_manage_clans: true }, null);
    expect(caps).toEqual({
      canManageFull: true,
      canAdd: true,
      canRemoveMembers: true,
      canTogglePriority: true,
      isLeader: false,
    });
  });

  it('grants full control to the clan leader per the server-computed viewer_manage_level', () => {
    const caps = deriveCapabilities({ player_id: 'p-leader', can_manage_clans: false }, 'full');
    expect(caps.canManageFull).toBe(true);
    expect(caps.canTogglePriority).toBe(true);
    expect(caps.isLeader).toBe(true);
  });

  it('grants a deputy add/remove/priority-toggle but not full control', () => {
    const caps = deriveCapabilities({ player_id: 'p-deputy', can_manage_clans: false }, 'deputy');
    expect(caps.canManageFull).toBe(false);
    expect(caps.canAdd).toBe(true);
    expect(caps.canRemoveMembers).toBe(true);
    expect(caps.canTogglePriority).toBe(true);
  });

  it('grants a rank-and-file member nothing', () => {
    const caps = deriveCapabilities({ player_id: 'p-member', can_manage_clans: false }, null);
    expect(caps).toEqual({
      canManageFull: false,
      canAdd: false,
      canRemoveMembers: false,
      canTogglePriority: false,
      isLeader: false,
    });
  });

  it('grants a leader full control even when their own row is off the loaded/paginated members page (#509)', () => {
    // The server computes viewer_manage_level independently of `items` — a
    // leader whose row fell off the current search/sort/page still gets it.
    const caps = deriveCapabilities({ player_id: 'p-leader', can_manage_clans: false }, 'full');
    expect(caps.canManageFull).toBe(true);
  });
});

describe('RosterRow', () => {
  const fullCaps = {
    canManageFull: true,
    canAdd: true,
    canRemoveMembers: true,
    canTogglePriority: true,
    isLeader: false,
  };
  const deputyCaps = {
    canManageFull: false,
    canAdd: true,
    canRemoveMembers: true,
    canTogglePriority: true,
    isLeader: false,
  };
  const memberCaps = {
    canManageFull: false,
    canAdd: false,
    canRemoveMembers: false,
    canTogglePriority: false,
    isLeader: false,
  };

  it('shows transfer + role select for a non-leader when the actor has full control', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <RosterRow
            member={member({ player_id: 'p-member', member_role: 'member' })}
            caps={fullCaps}
            busy={false}
            onChangeRole={noop}
            onRemove={noop}
            onTransfer={noop}
            onTogglePriority={noopToggle}
          />
        </tbody>
      </table>,
    );
    expect(html).toContain('Передать лидерство');
    expect(html).toContain('Удалить Командир из клана');
    expect(html).toContain('<select');
  });

  it('never offers to remove or transfer the leader', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <RosterRow
            member={member({ player_id: 'p-leader', member_role: 'leader' })}
            caps={fullCaps}
            busy={false}
            onChangeRole={noop}
            onRemove={noop}
            onTransfer={noop}
            onTogglePriority={noopToggle}
          />
        </tbody>
      </table>,
    );
    expect(html).not.toContain('Передать лидерство');
    expect(html).not.toContain('из клана');
    expect(html).toContain('Глава');
  });

  it('lets a deputy remove a member but not transfer or change roles', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <RosterRow
            member={member({ player_id: 'p-member', member_role: 'member' })}
            caps={deputyCaps}
            busy={false}
            onChangeRole={noop}
            onRemove={noop}
            onTransfer={noop}
            onTogglePriority={noopToggle}
          />
        </tbody>
      </table>,
    );
    expect(html).toContain('Удалить Командир из клана');
    expect(html).not.toContain('Передать лидерство');
    expect(html).not.toContain('<select');
  });

  it('does not let a deputy remove another deputy', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <RosterRow
            member={member({ player_id: 'p-deputy', member_role: 'deputy' })}
            caps={deputyCaps}
            busy={false}
            onChangeRole={noop}
            onRemove={noop}
            onTransfer={noop}
            onTogglePriority={noopToggle}
          />
        </tbody>
      </table>,
    );
    expect(html).not.toContain('из клана');
  });

  // Audit #125 — mirrors the API: a deputy toggles priority for members only.
  it.each(['leader', 'deputy'] as const)(
    'shows a deputy the priority of a %s read-only',
    (memberRole) => {
      const html = renderToStaticMarkup(
        <table>
          <tbody>
            <RosterRow
              member={member({ player_id: `p-${memberRole}`, member_role: memberRole })}
              caps={deputyCaps}
              busy={false}
              onChangeRole={noop}
              onRemove={noop}
              onTransfer={noop}
              onTogglePriority={noopToggle}
            />
          </tbody>
        </table>,
      );
      expect(html).not.toContain('type="checkbox"');
    },
  );

  it('lets a deputy toggle the priority of a rank-and-file member', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <RosterRow
            member={member({ player_id: 'p-member', member_role: 'member' })}
            caps={deputyCaps}
            busy={false}
            onChangeRole={noop}
            onRemove={noop}
            onTransfer={noop}
            onTogglePriority={noopToggle}
          />
        </tbody>
      </table>,
    );
    expect(html).toContain('type="checkbox"');
  });

  it('renders an enabled priority checkbox for a manager', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <RosterRow
            member={member({ has_priority: true })}
            caps={fullCaps}
            busy={false}
            onChangeRole={noop}
            onRemove={noop}
            onTransfer={noop}
            onTogglePriority={noopToggle}
          />
        </tbody>
      </table>,
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).not.toContain('disabled=""');
  });

  it('renders a locked, disabled checkbox with a tooltip when priority comes from a role', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <RosterRow
            member={member({ reserve_from_role: true })}
            caps={fullCaps}
            busy={false}
            onChangeRole={noop}
            onRemove={noop}
            onTransfer={noop}
            onTogglePriority={noopToggle}
          />
        </tbody>
      </table>,
    );
    expect(html).toContain('Приоритет из другого источника');
    expect(html).toContain('disabled=""');
  });

  it('renders a read-only priority indicator for a rank-and-file viewer', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <RosterRow
            member={member({ has_priority: true })}
            caps={memberCaps}
            busy={false}
            onChangeRole={noop}
            onRemove={noop}
            onTransfer={noop}
            onTogglePriority={noopToggle}
          />
        </tbody>
      </table>,
    );
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('да');
  });
});

describe('RosterPanel', () => {
  it('is a valid React component', () => {
    expect(typeof RosterPanel).toBe('function');
  });

  it('renders the empty roster state without crashing', () => {
    const html = renderToStaticMarkup(<RosterPanel clanId="clan-1" />);
    expect(html).toContain('Ростер');
    // #817: the loading announcement is filled in after mount, so the
    // server-rendered markup carries the empty live region.
    expect(html).toContain('<span role="status" class="sr-only"></span>');
  });
});

describe('RosterPanel (rendered)', () => {
  const leaderMember = member({ player_id: 'p-leader', has_priority: false });

  function mockFetch(opts: { priorityOk: boolean }) {
    let hasPriority = false;
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ player_id: 'p-leader', can_manage_clans: true }), {
            status: 200,
          }),
        );
      }
      if (url.startsWith('/api/v1/clans/clan-1/members') && (!init || init.method === undefined)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              clan_id: 'clan-1',
              items: [{ ...leaderMember, has_priority: hasPriority }],
              total: 1,
              page: 1,
              limit: 25,
              priority_count: hasPriority ? 1 : 0,
              max_priority_slots: 5,
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('/priority') && init?.method === 'PUT') {
        if (!opts.priorityOk) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'priority_expired' }), { status: 409 }),
          );
        }
        hasPriority = true;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              player_id: 'p-leader',
              has_priority: true,
              priority_count: 1,
              max_priority_slots: 5,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`));
    });
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('grants the leader management controls even when their own row is off the loaded page (#509)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ player_id: 'p-leader', can_manage_clans: false }), {
            status: 200,
          }),
        );
      }
      if (url.startsWith('/api/v1/clans/clan-1/members')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              clan_id: 'clan-1',
              // The leader's own row (p-leader) is not on this page — a
              // search, sort or later page pushed it off — yet the server
              // still reports the leader's real manage level.
              items: [member({ player_id: 'p-other', member_role: 'member' })],
              total: 2,
              page: 1,
              limit: 25,
              priority_count: 0,
              max_priority_slots: 5,
              viewer_manage_level: 'full',
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RosterPanel clanId="clan-1" />);

    expect(await screen.findByRole('button', { name: 'Добавить участника' })).toBeInTheDocument();
  });

  it('uses the canManageClans prop instead of fetching /me (#522)', async () => {
    const fetchMock = mockFetch({ priorityOk: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<RosterPanel clanId="clan-1" canManageClans={true} />);

    expect(await screen.findByRole('button', { name: 'Добавить участника' })).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).not.toContain('/api/v1/me');
  });

  it('renders a CSV export link pointing at the roster export endpoint', async () => {
    vi.stubGlobal('fetch', mockFetch({ priorityOk: true }));
    render(<RosterPanel clanId="clan-1" />);
    const link = await screen.findByRole('link', { name: 'Экспорт CSV' });
    expect(link).toHaveAttribute('href', '/api/v1/clans/clan-1/roster/export?format=csv');
  });

  it('locks the priority checkbox for 3s after a successful toggle, then re-enables it', async () => {
    // The lock is a 3 s setTimeout; fake timers step over it instead of the
    // test sleeping. shouldAdvanceTime keeps the fake clock moving with real
    // time, which Testing Library's waitFor needs to settle.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', mockFetch({ priorityOk: true }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RosterPanel clanId="clan-1" />);

    const checkbox = await screen.findByRole('checkbox', { name: 'Приоритет в очереди' });
    expect(checkbox).not.toBeDisabled();

    await user.click(checkbox);
    await screen.findByRole('checkbox', { name: 'Приоритет в очереди', checked: true });
    expect(screen.getByRole('checkbox', { name: 'Приоритет в очереди' })).toBeDisabled();

    // Two seconds in the row is still locked, and no longer merely busy: the
    // toggle request finished long ago.
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole('checkbox', { name: 'Приоритет в очереди' })).toBeDisabled();

    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('checkbox', { name: 'Приоритет в очереди' })).not.toBeDisabled();
  });

  it('reverts the checkbox and shows an error banner when the toggle fails', async () => {
    vi.stubGlobal('fetch', mockFetch({ priorityOk: false }));
    const user = userEvent.setup();
    render(<RosterPanel clanId="clan-1" />);

    const checkbox = await screen.findByRole('checkbox', { name: 'Приоритет в очереди' });
    await user.click(checkbox);

    expect(await screen.findByText('Срок приоритета клана истёк')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Приоритет в очереди' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Приоритет в очереди' })).not.toBeDisabled();
  });
});

describe('RosterPanel paging', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('steps back to the last existing page when the current one becomes empty', async () => {
    const pageOf = (page: number) => {
      const emptied = page === 2;
      return new Response(
        JSON.stringify({
          clan_id: 'clan-1',
          items: emptied
            ? []
            : [member({ player_id: `p-${page}`, canonical_name: 'Боец страницы' })],
          total: emptied ? 25 : 60,
          page,
          limit: 25,
          priority_count: 0,
          max_priority_slots: 5,
        }),
        { status: 200 },
      );
    };
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/me') return Promise.resolve(new Response('{}', { status: 200 }));
      const page = Number(new URL(url, 'http://x').searchParams.get('page'));
      return Promise.resolve(pageOf(page));
    });
    vi.stubGlobal('fetch', fetchSpy);
    const user = userEvent.setup();
    render(<RosterPanel clanId="clan-1" />);

    await user.click(await screen.findByRole('button', { name: 'Вперёд' }));

    await waitFor(() => {
      const pages = fetchSpy.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes('/members'))
        .map((url) => new URL(url, 'http://x').searchParams.get('page'));
      expect(pages).toEqual(['1', '2', '1']);
    });
    expect(screen.queryByText('В клане пока нет участников')).not.toBeInTheDocument();
  });
});

describe('RosterPanel — подтверждение удаления', () => {
  const ordinary = member({
    player_id: 'p-member',
    canonical_name: 'Боец',
    member_role: 'member',
  });

  function mockFetch() {
    const deleted: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/v1/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ player_id: 'p-boss', can_manage_clans: true }), {
            status: 200,
          }),
        );
      }
      if (url.startsWith('/api/v1/clans/clan-1/members') && init?.method === 'DELETE') {
        deleted.push(url);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (url.startsWith('/api/v1/clans/clan-1/members')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              clan_id: 'clan-1',
              items: deleted.length > 0 ? [] : [ordinary],
              total: deleted.length > 0 ? 0 : 1,
              page: 1,
              limit: 25,
              priority_count: 0,
              max_priority_slots: 5,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url} ${init?.method ?? 'GET'}`));
    });
    return { fetchMock, deleted };
  }

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('спрашивает подтверждение диалогом, а не confirm(), и удаляет после согласия', async () => {
    const { fetchMock, deleted } = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RosterPanel clanId="clan-1" />);

    await user.click(await screen.findByRole('button', { name: 'Удалить Боец из клана' }));

    const dialog = await screen.findByRole('dialog', { name: 'Удалить участника?' });
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));

    await waitFor(() => {
      expect(deleted).toEqual(['/api/v1/clans/clan-1/members/p-member']);
    });
  });

  it('оставляет участника в клане, если подтверждение отменили', async () => {
    const { fetchMock, deleted } = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RosterPanel clanId="clan-1" />);

    await user.click(await screen.findByRole('button', { name: 'Удалить Боец из клана' }));

    // Отказаться можно и крестиком, и кнопкой подвала — у обоих доступное имя
    // «Отмена», поэтому запрос делается внутри самого диалога и берёт первый.
    const dialog = await screen.findByRole('dialog', { name: 'Удалить участника?' });
    await user.click(within(dialog).getAllByRole('button', { name: 'Отмена' })[0]!);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Удалить участника?' })).not.toBeInTheDocument();
    });
    expect(deleted).toEqual([]);
  });
});

describe('RosterPanel — добавление первого участника', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function addCandidate(postBody: Record<string, unknown>) {
    const leader = member({ player_id: 'p-leader' });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const json = (body: unknown, status = 200) =>
          Promise.resolve(new Response(JSON.stringify(body), { status }));
        if (url === '/api/v1/me') {
          return json({ player_id: 'p-leader', can_manage_clans: true });
        }
        if (url.startsWith('/api/v1/players/search')) {
          return json({
            items: [
              {
                id: 'p-new',
                canonical_name: 'Новичок',
                steam_id64: '76561198000000001',
                eos_id: null,
                clan_id: null,
                clan_name: null,
              },
            ],
          });
        }
        if (url === '/api/v1/clans/clan-1/members' && init?.method === 'POST') {
          return json(postBody, 201);
        }
        if (url.startsWith('/api/v1/clans/clan-1/members')) {
          return json({
            clan_id: 'clan-1',
            items: [leader],
            total: 1,
            page: 1,
            limit: 25,
            priority_count: 0,
            max_priority_slots: 5,
          });
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    const user = userEvent.setup();
    render(<RosterPanel clanId="clan-1" />);
    await user.click(await screen.findByRole('button', { name: 'Добавить участника' }));
    await user.type(await screen.findByRole('searchbox', { name: 'Поиск игрока' }), 'Нович{Enter}');
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Добавить' }));
  }

  it('показывает баннер, когда API сообщил role_overridden', async () => {
    await addCandidate({ player_id: 'p-new', member_role: 'leader', role_overridden: true });

    expect(await screen.findByText('Роль изменена автоматически')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Первый участник клана всегда становится главой — выбранная роль не применена.',
      ),
    ).toBeInTheDocument();
  });

  it('не показывает баннер, когда роль применена как запрошено', async () => {
    await addCandidate({ player_id: 'p-new', member_role: 'member' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Роль изменена автоматически')).not.toBeInTheDocument();
  });
});
