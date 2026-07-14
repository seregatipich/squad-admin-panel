import { describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  buildManagedSegment,
  END_MARKER,
  findManagedSegment,
  hashSegment,
  spliceManagedSegment,
} from '../src/segment.js';

describe('buildManagedSegment — clan priority (CLAN-4)', () => {
  it('emits a constant ClanPriority group and Admin lines with a clan comment, sorted by eos_id', () => {
    const out = buildManagedSegment({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [{ eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin' }],
      clanPriority: [
        { eosId: '0002d40486d9414e8e15c66eb3dbf70d', clanName: 'Бета' },
        { eosId: '0002c30386d9414e8e15c66eb3dbf70c', clanName: 'Альфа' },
      ],
    });
    expect(out.body).toContain('Group=ClanPriority:reserve');
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

  it('emits neither the group nor any Admin= line when clanPriority is empty or absent', () => {
    const withEmpty = buildManagedSegment({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [],
      clanPriority: [],
    });
    const withoutField = buildManagedSegment({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [],
    });
    expect(withEmpty.body).not.toContain('ClanPriority');
    expect(withoutField.body).not.toContain('ClanPriority');
    expect(withEmpty.hash).toBe(withoutField.hash);
  });

  it('skips the synthetic Group= line when a real role is already named ClanPriority, but still emits Admin lines', () => {
    const out = buildManagedSegment({
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

  it('produces a deterministic hash regardless of clanPriority input order', () => {
    const a = buildManagedSegment({
      roles: [],
      admins: [],
      clanPriority: [
        { eosId: 'aaa', clanName: 'X' },
        { eosId: 'bbb', clanName: 'Y' },
      ],
    });
    const b = buildManagedSegment({
      roles: [],
      admins: [],
      clanPriority: [
        { eosId: 'bbb', clanName: 'Y' },
        { eosId: 'aaa', clanName: 'X' },
      ],
    });
    expect(a.hash).toBe(b.hash);
  });
});

describe('buildManagedSegment', () => {
  it('emits Group= per role with permissions and Admin= per assignment, sorted', () => {
    const out = buildManagedSegment({
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
    // admins sorted by role then eos_id
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

  it('uses CRLF line endings', () => {
    const out = buildManagedSegment({
      roles: [{ name: 'Admin', squadPermissions: ['kick'] }],
      admins: [{ eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin' }],
    });
    expect(out.body.split('\r\n').length).toBeGreaterThan(2);
    expect(out.body.includes('\n\n')).toBe(false);
  });

  it('produces a stable sha256 hash for identical inputs', () => {
    const a = buildManagedSegment({
      roles: [{ name: 'Admin', squadPermissions: ['kick', 'ban'] }],
      admins: [{ eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin' }],
    });
    const b = buildManagedSegment({
      roles: [{ name: 'Admin', squadPermissions: ['ban', 'kick'] }],
      admins: [{ eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin' }],
    });
    expect(a.hash).toBe(b.hash);
  });

  it('emits empty body with markers when no roles or admins', () => {
    const out = buildManagedSegment({ roles: [], admins: [] });
    expect(out.body.startsWith(BEGIN_MARKER)).toBe(true);
    expect(out.body.endsWith(END_MARKER)).toBe(true);
    expect(out.groupsCount).toBe(0);
    expect(out.adminsCount).toBe(0);
  });

  it('appends comment after Admin= line when provided', () => {
    const out = buildManagedSegment({
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

describe('findManagedSegment', () => {
  it('returns null when no markers', () => {
    expect(findManagedSegment('plain old config')).toBeNull();
  });

  it('finds the segment between markers', () => {
    const text = `keep\nthis\n${BEGIN_MARKER}\nfoo\n${END_MARKER}\ntail`;
    const out = findManagedSegment(text);
    expect(out).not.toBeNull();
    expect(out?.segment.startsWith(BEGIN_MARKER)).toBe(true);
    expect(out?.segment.endsWith(END_MARKER)).toBe(true);
  });
});

describe('spliceManagedSegment', () => {
  it('replaces existing segment in place leaving the rest untouched', () => {
    const before = `prelude\r\n${BEGIN_MARKER}\r\nold\r\n${END_MARKER}\r\ntail\r\n`;
    const newSegment = `${BEGIN_MARKER}\r\nfresh\r\n${END_MARKER}`;
    const result = spliceManagedSegment(before, newSegment);
    expect(result).toBe(`prelude\r\n${newSegment}\r\ntail\r\n`);
    expect(result.includes('old')).toBe(false);
  });

  it('emits the segment alone when content is empty', () => {
    const newSegment = `${BEGIN_MARKER}\r\n${END_MARKER}`;
    const result = spliceManagedSegment('', newSegment);
    expect(result.startsWith(BEGIN_MARKER)).toBe(true);
  });

  it('prepends the segment to existing content when no markers exist', () => {
    const newSegment = `${BEGIN_MARKER}\r\n${END_MARKER}`;
    const result = spliceManagedSegment('user content\r\n', newSegment);
    expect(result.startsWith(BEGIN_MARKER)).toBe(true);
    expect(result).toContain('user content');
  });
});

describe('hashSegment', () => {
  it('returns 64-char hex sha256', () => {
    expect(hashSegment('foo')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('drift detection (passive vs active)', () => {
  it('hash differs => caller treats it as drift on a passive sweep', () => {
    const original = `${BEGIN_MARKER}\r\nGroup=Old:kick\r\n${END_MARKER}\r\nUserBoundedSection=keepme\r\n`;
    const located = findManagedSegment(original);
    expect(located).not.toBeNull();
    const fresh = buildManagedSegment({
      roles: [{ name: 'New', squadPermissions: ['ban'] }],
      admins: [],
    });
    const oldHash = hashSegment(located?.segment ?? '');
    expect(oldHash).not.toBe(fresh.hash);
    const isPassiveCheck = true;
    const hashesMatch = oldHash === fresh.hash;
    const willWrite = !isPassiveCheck && !hashesMatch;
    expect(willWrite).toBe(false);
  });

  it('preserves user content outside markers (e.g. //SQSTAT DELIMETER blocks)', () => {
    const sqstat = '//SQSTAT DELIMETER START\r\nSomeStat=42\r\n//SQSTAT DELIMETER END\r\n';
    const original = `${BEGIN_MARKER}\r\nGroup=Old:kick\r\n${END_MARKER}\r\n${sqstat}`;
    const fresh = buildManagedSegment({
      roles: [{ name: 'New', squadPermissions: ['ban'] }],
      admins: [],
    });
    const out = spliceManagedSegment(original, fresh.body);
    expect(out).toContain(sqstat);
    expect(out).toContain('Group=New:ban');
    expect(out).not.toContain('Group=Old:kick');
  });
});
