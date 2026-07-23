import { describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  buildManagedSegmentBody,
  CLAN_PRIORITY_GROUP_NAME,
  END_MARKER,
  findManagedSegment,
  type SegmentInputs,
  spliceManagedSegment,
} from '../src/admins-config.js';

/**
 * A representative role + admin + clan-priority snapshot whose byte output is
 * pinned below. Both the config-sync worker (`buildManagedSegment`) and the web
 * Admins.cfg preview call `buildManagedSegmentBody`, so this expected string is
 * the single source of truth for "byte-identical" (issue ROLE-6 acceptance).
 */
const REPRESENTATIVE_INPUTS: SegmentInputs = {
  roles: [
    { name: 'Admin', squadPermissions: ['kick', 'ban', 'cameraman'] },
    { name: 'QueuePriority', squadPermissions: ['reserve'] },
    { name: 'NoPerms', squadPermissions: [] },
  ],
  admins: [
    { eosId: '0002b20286d9414e8e15c66eb3dbf70b', roleName: 'Admin' },
    { eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin', comment: 'manual addition' },
    { eosId: '0002c30386d9414e8e15c66eb3dbf70c', roleName: 'QueuePriority' },
    { eosId: '0002d40486d9414e8e15c66eb3dbf70d', roleName: 'NoPerms' },
  ],
  clanPriority: [
    { eosId: '0002e50586d9414e8e15c66eb3dbf70e', clanName: 'Альфа' },
    { eosId: '0002f60686d9414e8e15c66eb3dbf70f', clanName: 'Бета' },
  ],
};

export const REPRESENTATIVE_BODY = [
  '//SQUAD-PANEL BEGIN — не редактировать вручную',
  'Group=Admin:ban,cameraman,kick',
  'Group=QueuePriority:reserve',
  'Group=ClanPriority:reserve',
  '',
  'Admin=0002a10186d9414e8e15c66eb3dbf70a:Admin // manual addition',
  'Admin=0002b20286d9414e8e15c66eb3dbf70b:Admin',
  'Admin=0002c30386d9414e8e15c66eb3dbf70c:QueuePriority',
  'Admin=0002e50586d9414e8e15c66eb3dbf70e:ClanPriority // clan:Альфа',
  'Admin=0002f60686d9414e8e15c66eb3dbf70f:ClanPriority // clan:Бета',
  '//SQUAD-PANEL END',
].join('\r\n');

describe('buildManagedSegmentBody — byte identity (ROLE-6 / SYNC-2 shared generator)', () => {
  it('produces the pinned byte-for-byte body for the representative snapshot', () => {
    const out = buildManagedSegmentBody(REPRESENTATIVE_INPUTS);
    expect(out.body).toBe(REPRESENTATIVE_BODY);
    expect(out.groupsCount).toBe(3);
    expect(out.adminsCount).toBe(5);
  });

  it('is deterministic regardless of input ordering', () => {
    const shuffled: SegmentInputs = {
      roles: [...REPRESENTATIVE_INPUTS.roles].reverse(),
      admins: [...REPRESENTATIVE_INPUTS.admins].reverse(),
      clanPriority: [...(REPRESENTATIVE_INPUTS.clanPriority ?? [])].reverse(),
    };
    expect(buildManagedSegmentBody(shuffled).body).toBe(REPRESENTATIVE_BODY);
  });
});

describe('buildManagedSegmentBody', () => {
  it('emits Group= per role with sorted permissions and Admin= per assignment, sorted', () => {
    const out = buildManagedSegmentBody({
      roles: [
        { name: 'Admin', squadPermissions: ['kick', 'ban', 'cameraman'] },
        { name: 'QueuePriority', squadPermissions: ['reserve'] },
        { name: 'NoPerms', squadPermissions: [] },
      ],
      admins: [
        { eosId: '0002b20286d9414e8e15c66eb3dbf70b', roleName: 'Admin' },
        { eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin' },
        { eosId: '0002c30386d9414e8e15c66eb3dbf70c', roleName: 'QueuePriority' },
        { eosId: '0002d40486d9414e8e15c66eb3dbf70d', roleName: 'NoPerms' },
      ],
    });
    expect(out.body).toContain(BEGIN_MARKER);
    expect(out.body).toContain(END_MARKER);
    expect(out.body).toContain('Group=Admin:ban,cameraman,kick');
    expect(out.body).toContain('Group=QueuePriority:reserve');
    expect(out.body).not.toContain('Group=NoPerms');
    const adminLines = out.body
      .split('\r\n')
      .filter((l) => l.startsWith('Admin='))
      .map((l) => l.replace('Admin=', ''));
    expect(adminLines).toEqual([
      '0002a10186d9414e8e15c66eb3dbf70a:Admin',
      '0002b20286d9414e8e15c66eb3dbf70b:Admin',
      '0002c30386d9414e8e15c66eb3dbf70c:QueuePriority',
    ]);
    expect(out.groupsCount).toBe(2);
    expect(out.adminsCount).toBe(3);
  });

  it('uses CRLF line endings and no lone LF runs', () => {
    const out = buildManagedSegmentBody({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [{ eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin' }],
    });
    expect(out.body.split('\r\n').length).toBeGreaterThan(2);
    expect(out.body.includes('\n\n')).toBe(false);
  });

  it('emits an empty body with markers when there are no roles or admins', () => {
    const out = buildManagedSegmentBody({ roles: [], admins: [] });
    expect(out.body).toBe(`${BEGIN_MARKER} — не редактировать вручную\r\n${END_MARKER}`);
    expect(out.groupsCount).toBe(0);
    expect(out.adminsCount).toBe(0);
  });

  it('omits the separator blank line when there are groups but no admins', () => {
    const out = buildManagedSegmentBody({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [],
    });
    expect(out.body).toBe(
      `${BEGIN_MARKER} — не редактировать вручную\r\nGroup=Admin:kick\r\n${END_MARKER}`,
    );
  });

  it('appends the comment after an Admin= line when provided', () => {
    const out = buildManagedSegmentBody({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [
        {
          eosId: '0002a10186d9414e8e15c66eb3dbf70a',
          roleName: 'Admin',
          comment: 'manual addition',
        },
      ],
    });
    expect(out.body).toContain('Admin=0002a10186d9414e8e15c66eb3dbf70a:Admin // manual addition');
  });
});

describe('buildManagedSegmentBody — clan priority (CLAN-4)', () => {
  it('emits a constant ClanPriority group and clan Admin lines sorted by eos_id', () => {
    const out = buildManagedSegmentBody({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [{ eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin' }],
      clanPriority: [
        { eosId: '0002d40486d9414e8e15c66eb3dbf70d', clanName: 'Бета' },
        { eosId: '0002c30386d9414e8e15c66eb3dbf70c', clanName: 'Альфа' },
      ],
    });
    expect(out.body).toContain(`Group=${CLAN_PRIORITY_GROUP_NAME}:reserve`);
    const adminLines = out.body
      .split('\r\n')
      .filter((l) => l.startsWith('Admin='))
      .map((l) => l.replace('Admin=', ''));
    expect(adminLines).toEqual([
      '0002a10186d9414e8e15c66eb3dbf70a:Admin',
      '0002c30386d9414e8e15c66eb3dbf70c:ClanPriority // clan:Альфа',
      '0002d40486d9414e8e15c66eb3dbf70d:ClanPriority // clan:Бета',
    ]);
    expect(out.groupsCount).toBe(2);
    expect(out.adminsCount).toBe(3);
  });

  it('emits neither the group nor any clan line when clanPriority is empty or absent', () => {
    const withEmpty = buildManagedSegmentBody({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [],
      clanPriority: [],
    });
    const withoutField = buildManagedSegmentBody({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [],
    });
    expect(withEmpty.body).not.toContain('ClanPriority');
    expect(withoutField.body).not.toContain('ClanPriority');
    expect(withEmpty.body).toBe(withoutField.body);
  });

  it('skips the synthetic Group= when a real role is named ClanPriority, but keeps clan Admin lines', () => {
    const out = buildManagedSegmentBody({
      roles: [{ name: 'ClanPriority', squadPermissions: ['reserve', 'cameraman'] }],
      admins: [],
      clanPriority: [{ eosId: '0002c30386d9414e8e15c66eb3dbf70c', clanName: 'Альфа' }],
    });
    const groupLines = out.body.split('\r\n').filter((l) => l.startsWith('Group='));
    expect(groupLines).toEqual(['Group=ClanPriority:cameraman,reserve']);
    expect(out.body).toContain('Admin=0002c30386d9414e8e15c66eb3dbf70c:ClanPriority // clan:Альфа');
    expect(out.groupsCount).toBe(1);
    expect(out.adminsCount).toBe(1);
  });
});

describe('findManagedSegment', () => {
  it('returns null when the begin marker is missing', () => {
    expect(findManagedSegment('plain old config')).toBeNull();
  });

  it('returns null when the begin marker is present but the end marker is missing', () => {
    expect(findManagedSegment(`prefix\n${BEGIN_MARKER}\nGroup=X:kick\n`)).toBeNull();
  });

  it('finds the segment between markers with correct offsets', () => {
    const text = `keep\nthis\n${BEGIN_MARKER}\nfoo\n${END_MARKER}\ntail`;
    const out = findManagedSegment(text);
    expect(out).not.toBeNull();
    expect(out?.segment.startsWith(BEGIN_MARKER)).toBe(true);
    expect(out?.segment.endsWith(END_MARKER)).toBe(true);
    expect(text.slice(out?.start, out?.end)).toBe(out?.segment);
  });
});

describe('spliceManagedSegment', () => {
  it('replaces an existing segment in place, leaving the rest untouched', () => {
    const before = `prelude\r\n${BEGIN_MARKER}\r\nold\r\n${END_MARKER}\r\ntail\r\n`;
    const fresh = `${BEGIN_MARKER}\r\nfresh\r\n${END_MARKER}`;
    const result = spliceManagedSegment(before, fresh);
    expect(result).toBe(`prelude\r\n${fresh}\r\ntail\r\n`);
    expect(result.includes('old')).toBe(false);
  });

  it('emits the segment plus a trailing CRLF when content is empty', () => {
    const fresh = `${BEGIN_MARKER}\r\n${END_MARKER}`;
    expect(spliceManagedSegment('', fresh)).toBe(`${fresh}\r\n`);
  });

  it('prepends the segment and preserves existing content when no markers exist', () => {
    const fresh = `${BEGIN_MARKER}\r\n${END_MARKER}`;
    const result = spliceManagedSegment('user content\r\n', fresh);
    expect(result).toBe(`${fresh}\r\n\r\nuser content\r\n`);
  });
});
