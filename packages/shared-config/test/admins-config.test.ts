import { describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  buildManagedSegmentBody,
  CLAN_PRIORITY_GROUP_NAME,
  END_MARKER,
  findManagedSegment,
  isAdminsCfgSafeRoleName,
  isAdminsCfgSingleLineText,
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

const REPRESENTATIVE_BODY = [
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

const INJECTED_EOS = '0002ffffffffffffffffffffffffffff';
const VICTIM_EOS = '0002a10186d9414e8e15c66eb3dbf70a';

/** Every line strictly between the BEGIN and END markers of a generated body. */
function innerLines(body: string): string[] {
  const lines = body.split('\r\n');
  return lines.slice(1, -1);
}

/**
 * Structural invariant of the managed segment: exactly one BEGIN and one END
 * marker, and every inner line is blank, a Group= definition or an Admin=
 * grant whose group name is one Admins.cfg can parse unambiguously.
 */
function expectWellFormedSegment(body: string): void {
  expect(body.split(BEGIN_MARKER)).toHaveLength(2);
  expect(body.split(END_MARKER)).toHaveLength(2);
  expect(body.split('\r\n').every((line) => !/[\r\n\u2028\u2029]/.test(line))).toBe(true);
  for (const line of innerLines(body)) {
    expect(line).toMatch(/^(|Group=[^:,/]+:[a-z,]+|Admin=[0-9a-f]{32}:[^:,/]+( \/\/ .*)?)$/);
  }
}

describe('buildManagedSegmentBody — injection hardening (issue #11)', () => {
  it('drops a role whose name carries CR/LF instead of emitting injected Admin= lines', () => {
    const name = `X:ban\r\nAdmin=${INJECTED_EOS}:X\r\nGroup=Y`;
    const out = buildManagedSegmentBody({
      roles: [
        { name, squadPermissions: ['kick'] },
        { name: 'Admin', squadPermissions: ['kick'] },
      ],
      admins: [
        { eosId: VICTIM_EOS, roleName: name },
        { eosId: '0002b20286d9414e8e15c66eb3dbf70b', roleName: 'Admin' },
      ],
    });
    expect(out.body).not.toContain(INJECTED_EOS);
    expect(out.body).not.toContain(VICTIM_EOS);
    expect(out.body).not.toContain('Group=X');
    expect(out.body).not.toContain('Group=Y');
    expect(out.groupsCount).toBe(1);
    expect(out.adminsCount).toBe(1);
    expectWellFormedSegment(out.body);
  });

  it.each([
    ['colon', 'A:ban'],
    ['comma', 'A,B'],
    ['slash / end marker', 'A//SQUAD-PANEL END'],
    ['unicode line separator', 'A\u2028B'],
    ['tab', 'A\tB'],
    ['blank', '   '],
  ])('drops a role whose name contains a %s', (_label, name) => {
    const out = buildManagedSegmentBody({
      roles: [{ name, squadPermissions: ['kick'] }],
      admins: [{ eosId: VICTIM_EOS, roleName: name }],
    });
    expect(out.body).toBe(`${BEGIN_MARKER} — не редактировать вручную\r\n${END_MARKER}`);
    expect(out.groupsCount).toBe(0);
    expect(out.adminsCount).toBe(0);
  });

  it('keeps Cyrillic and space-separated role names', () => {
    const out = buildManagedSegmentBody({
      roles: [{ name: 'Старший админ', squadPermissions: ['kick'] }],
      admins: [{ eosId: VICTIM_EOS, roleName: 'Старший админ' }],
    });
    expect(out.body).toContain('Group=Старший админ:kick');
    expect(out.body).toContain(`Admin=${VICTIM_EOS}:Старший админ`);
  });

  it('flattens CR/LF in an admin comment so it cannot add an Admin= or Group= line', () => {
    const out = buildManagedSegmentBody({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [
        {
          eosId: VICTIM_EOS,
          roleName: 'Admin',
          comment: `x\r\nGroup=Pwn:ban,kick\r\nAdmin=${INJECTED_EOS}:Pwn\nAdmin=${INJECTED_EOS}:Owner`,
        },
      ],
    });
    const adminLines = innerLines(out.body).filter((l) => l.startsWith('Admin='));
    const groupLines = innerLines(out.body).filter((l) => l.startsWith('Group='));
    expect(adminLines).toHaveLength(1);
    expect(adminLines[0]?.startsWith(`Admin=${VICTIM_EOS}:Admin // x `)).toBe(true);
    expect(groupLines).toEqual(['Group=Admin:kick']);
    expectWellFormedSegment(out.body);
  });

  it('flattens Unicode line/paragraph separators and other control characters in a comment', () => {
    const out = buildManagedSegmentBody({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [
        {
          eosId: VICTIM_EOS,
          roleName: 'Admin',
          comment: `a\u2028Admin=${INJECTED_EOS}:Admin\u2029b\u0085c\u0000d`,
        },
      ],
    });
    expect(innerLines(out.body).filter((l) => l.startsWith('Admin='))).toHaveLength(1);
    expectWellFormedSegment(out.body);
  });

  it('omits the comment suffix when the comment is only control characters', () => {
    const out = buildManagedSegmentBody({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [{ eosId: VICTIM_EOS, roleName: 'Admin', comment: '\r\n\t' }],
    });
    expect(innerLines(out.body)).toContain(`Admin=${VICTIM_EOS}:Admin`);
  });

  it('flattens CR/LF in a clan name so it cannot add an Admin= line', () => {
    const out = buildManagedSegmentBody({
      roles: [],
      admins: [],
      clanPriority: [{ eosId: VICTIM_EOS, clanName: `Альфа\r\nAdmin=${INJECTED_EOS}:Owner` }],
    });
    const adminLines = innerLines(out.body).filter((l) => l.startsWith('Admin='));
    expect(adminLines).toHaveLength(1);
    expect(adminLines[0]?.startsWith(`Admin=${VICTIM_EOS}:ClanPriority // clan:Альфа `)).toBe(true);
    expectWellFormedSegment(out.body);
  });

  it.each([
    ['comment', 'end'],
    ['clan name', 'end'],
    ['comment', 'begin'],
  ])(
    'a %s containing the %s marker cannot truncate the managed segment on the next sync',
    (field, which) => {
      const marker = which === 'end' ? END_MARKER : BEGIN_MARKER;
      const hostile = `a\r\nAdmin=${INJECTED_EOS}:Admin\r\n${marker}`;
      const out = buildManagedSegmentBody({
        roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
        admins: [
          { eosId: VICTIM_EOS, roleName: 'Admin', comment: field === 'comment' ? hostile : null },
        ],
        clanPriority: field === 'clan name' ? [{ eosId: VICTIM_EOS, clanName: hostile }] : [],
      });
      expectWellFormedSegment(out.body);

      const file = spliceManagedSegment('ServerAdmin=keep\r\n', out.body);
      const located = findManagedSegment(file);
      expect(located?.segment).toBe(out.body);

      const revoked = buildManagedSegmentBody({ roles: [], admins: [] });
      const resynced = spliceManagedSegment(file, revoked.body);
      expect(resynced).toBe(`${revoked.body}\r\n\r\nServerAdmin=keep\r\n`);
      expect(resynced).not.toContain(INJECTED_EOS);
      expect(resynced).not.toContain(VICTIM_EOS);
    },
  );
});

describe('isAdminsCfgSafeRoleName', () => {
  it.each(['Admin', 'QueuePriority', 'Старший админ', 'VIP-1', 'mod_2'])('accepts %s', (name) => {
    expect(isAdminsCfgSafeRoleName(name)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'A:B',
    'A,B',
    'A/B',
    'A\rB',
    'A\nB',
    'A\tB',
    'A\u2028B',
    'A\u2029B',
    'A\u0085B',
    'A\u007fB',
  ])('rejects %j', (name) => {
    expect(isAdminsCfgSafeRoleName(name)).toBe(false);
  });
});

describe('isAdminsCfgSingleLineText', () => {
  it('accepts ordinary single-line text, including slashes and colons', () => {
    expect(isAdminsCfgSingleLineText('выдано до 01.01: см. тикет // #42')).toBe(true);
  });

  it.each(['a\rb', 'a\nb', 'a\tb', 'a\u2028b', 'a\u2029b', 'a\u0000b', 'a\u0085b'])(
    'rejects %j',
    (text) => {
      expect(isAdminsCfgSingleLineText(text)).toBe(false);
    },
  );
});

describe('findManagedSegment', () => {
  it('returns null when the begin marker is missing', () => {
    expect(findManagedSegment('plain old config')).toBeNull();
  });

  it('treats an orphaned begin marker (no end marker) as a corrupt segment running to EOF', () => {
    const text = `prefix\n${BEGIN_MARKER}\nGroup=X:kick\n`;
    const out = findManagedSegment(text);
    expect(out).not.toBeNull();
    expect(out?.start).toBe(text.indexOf(BEGIN_MARKER));
    expect(out?.end).toBe(text.length);
    expect(out?.segment).toBe(text.slice(text.indexOf(BEGIN_MARKER)));
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

  it('replaces an orphaned begin marker (no end marker) instead of leaving it and prepending a duplicate', () => {
    const before = `prelude\r\n${BEGIN_MARKER}\r\nGroup=Admin:kick\r\n`;
    const fresh = `${BEGIN_MARKER}\r\nfresh\r\n${END_MARKER}`;
    const result = spliceManagedSegment(before, fresh);
    expect(result).toBe(`prelude\r\n${fresh}`);
    expect(result.includes('Group=Admin:kick')).toBe(false);
    // Only one BEGIN marker survives — no duplicate segment prepended in front.
    expect(result.split(BEGIN_MARKER)).toHaveLength(2);
  });
});
