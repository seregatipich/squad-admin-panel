// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import RosterPanel, {
  deriveCapabilities,
  formatLastSeen,
  formatOnlineDuration,
  memberRoleLabel,
  priorityErrorMessage,
  type RosterMember,
  RosterRow,
} from './RosterPanel';

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

  it('formats last seen and handles null', () => {
    expect(formatLastSeen(null)).toBe('—');
    expect(formatLastSeen('not-a-date')).toBe('—');
    expect(formatLastSeen('2026-07-01T12:00:00.000Z')).not.toBe('—');
  });

  it('labels roles in Russian', () => {
    expect(memberRoleLabel('leader')).toBe('Глава');
    expect(memberRoleLabel('deputy')).toBe('Зам');
    expect(memberRoleLabel('member')).toBe('Участник');
    expect(memberRoleLabel('unknown')).toBe('unknown');
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
  const roster = [
    member({ player_id: 'p-leader', member_role: 'leader' }),
    member({ player_id: 'p-deputy', member_role: 'deputy' }),
    member({ player_id: 'p-member', member_role: 'member' }),
  ];

  it('grants full control to a global clan manager', () => {
    const caps = deriveCapabilities({ player_id: 'p-outsider', can_manage_clans: true }, roster);
    expect(caps).toEqual({
      canManageFull: true,
      canAdd: true,
      canRemoveMembers: true,
      canTogglePriority: true,
    });
  });

  it('grants full control to the clan leader', () => {
    const caps = deriveCapabilities({ player_id: 'p-leader', can_manage_clans: false }, roster);
    expect(caps.canManageFull).toBe(true);
    expect(caps.canTogglePriority).toBe(true);
  });

  it('grants a deputy add/remove/priority-toggle but not full control', () => {
    const caps = deriveCapabilities({ player_id: 'p-deputy', can_manage_clans: false }, roster);
    expect(caps.canManageFull).toBe(false);
    expect(caps.canAdd).toBe(true);
    expect(caps.canRemoveMembers).toBe(true);
    expect(caps.canTogglePriority).toBe(true);
  });

  it('grants a rank-and-file member nothing', () => {
    const caps = deriveCapabilities({ player_id: 'p-member', can_manage_clans: false }, roster);
    expect(caps).toEqual({
      canManageFull: false,
      canAdd: false,
      canRemoveMembers: false,
      canTogglePriority: false,
    });
  });
});

describe('RosterRow', () => {
  const fullCaps = {
    canManageFull: true,
    canAdd: true,
    canRemoveMembers: true,
    canTogglePriority: true,
  };
  const deputyCaps = {
    canManageFull: false,
    canAdd: true,
    canRemoveMembers: true,
    canTogglePriority: true,
  };
  const memberCaps = {
    canManageFull: false,
    canAdd: false,
    canRemoveMembers: false,
    canTogglePriority: false,
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
    expect(html).toContain('Удалить');
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
    expect(html).not.toContain('Удалить');
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
    expect(html).toContain('Удалить');
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
    expect(html).not.toContain('Удалить');
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
    expect(html).toContain('В клане пока нет участников.');
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

  it('renders a CSV export link pointing at the roster export endpoint', async () => {
    vi.stubGlobal('fetch', mockFetch({ priorityOk: true }));
    render(<RosterPanel clanId="clan-1" />);
    const link = await screen.findByRole('link', { name: 'Экспорт CSV' });
    expect(link).toHaveAttribute('href', '/api/v1/clans/clan-1/roster/export?format=csv');
  });

  it('locks the priority checkbox for 3s after a successful toggle, then re-enables it', async () => {
    vi.stubGlobal('fetch', mockFetch({ priorityOk: true }));
    const user = userEvent.setup();
    render(<RosterPanel clanId="clan-1" />);

    const checkbox = await screen.findByRole('checkbox', { name: 'Приоритет в очереди' });
    expect(checkbox).not.toBeDisabled();

    await user.click(checkbox);
    await screen.findByRole('checkbox', { name: 'Приоритет в очереди', checked: true });
    expect(screen.getByRole('checkbox', { name: 'Приоритет в очереди' })).toBeDisabled();

    await screen.findByRole(
      'checkbox',
      { name: 'Приоритет в очереди' },
      { timeout: 4000, interval: 100 },
    );
    await new Promise((resolve) => setTimeout(resolve, 3100));
    expect(screen.getByRole('checkbox', { name: 'Приоритет в очереди' })).not.toBeDisabled();
  }, 10_000);

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
