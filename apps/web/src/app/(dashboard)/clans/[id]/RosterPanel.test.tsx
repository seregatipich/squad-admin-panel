import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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
    joined_at: overrides.joined_at ?? '2026-01-01T00:00:00.000Z',
    last_seen_at: overrides.last_seen_at ?? '2026-07-01T12:00:00.000Z',
    online_60d_seconds: overrides.online_60d_seconds ?? 7200,
  };
}

const noop = () => {};

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

describe('deriveCapabilities', () => {
  const roster = [
    member({ player_id: 'p-leader', member_role: 'leader' }),
    member({ player_id: 'p-deputy', member_role: 'deputy' }),
    member({ player_id: 'p-member', member_role: 'member' }),
  ];

  it('grants full control to a global clan manager', () => {
    const caps = deriveCapabilities({ player_id: 'p-outsider', can_manage_clans: true }, roster);
    expect(caps).toEqual({ canManageFull: true, canAdd: true, canRemoveMembers: true });
  });

  it('grants full control to the clan leader', () => {
    const caps = deriveCapabilities({ player_id: 'p-leader', can_manage_clans: false }, roster);
    expect(caps.canManageFull).toBe(true);
  });

  it('grants a deputy add/remove but not full control', () => {
    const caps = deriveCapabilities({ player_id: 'p-deputy', can_manage_clans: false }, roster);
    expect(caps.canManageFull).toBe(false);
    expect(caps.canAdd).toBe(true);
    expect(caps.canRemoveMembers).toBe(true);
  });

  it('grants a rank-and-file member nothing', () => {
    const caps = deriveCapabilities({ player_id: 'p-member', can_manage_clans: false }, roster);
    expect(caps).toEqual({ canManageFull: false, canAdd: false, canRemoveMembers: false });
  });
});

describe('RosterRow', () => {
  const fullCaps = { canManageFull: true, canAdd: true, canRemoveMembers: true };
  const deputyCaps = { canManageFull: false, canAdd: true, canRemoveMembers: true };

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
          />
        </tbody>
      </table>,
    );
    expect(html).not.toContain('Удалить');
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
