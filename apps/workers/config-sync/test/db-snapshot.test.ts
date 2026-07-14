import { describe, expect, it, vi } from 'vitest';
import { snapshotRolesAndAdmins } from '../src/db-snapshot.js';

function makeDb(roleRows: unknown[], adminRows: unknown[], clanPriorityRows: unknown[] = []) {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(() => {
      const results = [roleRows, adminRows, clanPriorityRows];
      const result = results[callIndex] ?? [];
      callIndex++;
      return Promise.resolve(result);
    }),
  } as never;
}

describe('snapshotRolesAndAdmins', () => {
  it('maps role rows to RoleEntry array', async () => {
    const db = makeDb([{ name: 'Admin', squad_permissions: ['kick', 'ban'] }], []);
    const { roles, admins } = await snapshotRolesAndAdmins(db);
    expect(roles).toEqual([{ name: 'Admin', squadPermissions: ['kick', 'ban'] }]);
    expect(admins).toEqual([]);
  });

  it('maps admin rows to AdminEntry array', async () => {
    const db = makeDb([], [{ eos_id: '0002a10186d9414e8e15c66eb3dbf70a', role_name: 'Admin' }]);
    const { roles, admins } = await snapshotRolesAndAdmins(db);
    expect(roles).toEqual([]);
    expect(admins).toEqual([{ eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin' }]);
  });

  it('returns empty arrays when queries return no rows', async () => {
    const db = makeDb([], []);
    const { roles, admins, clanPriority } = await snapshotRolesAndAdmins(db);
    expect(roles).toEqual([]);
    expect(admins).toEqual([]);
    expect(clanPriority).toEqual([]);
  });

  it('handles null squad_permissions with empty array fallback', async () => {
    const db = makeDb([{ name: 'NoPerms', squad_permissions: null }], []);
    const { roles } = await snapshotRolesAndAdmins(db);
    expect(roles).toEqual([{ name: 'NoPerms', squadPermissions: [] }]);
  });

  it('maps multiple roles and admins correctly', async () => {
    const db = makeDb(
      [
        { name: 'Admin', squad_permissions: ['kick'] },
        { name: 'Mod', squad_permissions: ['warn'] },
      ],
      [
        { eos_id: '0002a10186d9414e8e15c66eb3dbf70a', role_name: 'Admin' },
        { eos_id: '0002b20286d9414e8e15c66eb3dbf70b', role_name: 'Mod' },
      ],
    );
    const { roles, admins } = await snapshotRolesAndAdmins(db);
    expect(roles).toHaveLength(2);
    expect(admins).toHaveLength(2);
    expect(admins[0]).toEqual({ eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin' });
    expect(admins[1]).toEqual({ eosId: '0002b20286d9414e8e15c66eb3dbf70b', roleName: 'Mod' });
  });

  // The filtering semantics themselves (active/unexpired clan, soft-deleted
  // clan excluded, eos_id NULL excluded, reserve-role member excluded) live
  // in the SQL WHERE clause and are exercised against a real Postgres
  // instance by the config-sync contract/integration path — a mocked
  // `db.execute` can only verify that whatever rows Postgres returns are
  // mapped to ClanPriorityEntry correctly.
  it('maps clan-priority rows to ClanPriorityEntry array', async () => {
    const db = makeDb(
      [],
      [],
      [
        { eos_id: '0002c30386d9414e8e15c66eb3dbf70c', clan_name: 'Альфа' },
        { eos_id: '0002d40486d9414e8e15c66eb3dbf70d', clan_name: 'Бета' },
      ],
    );
    const { clanPriority } = await snapshotRolesAndAdmins(db);
    expect(clanPriority).toEqual([
      { eosId: '0002c30386d9414e8e15c66eb3dbf70c', clanName: 'Альфа' },
      { eosId: '0002d40486d9414e8e15c66eb3dbf70d', clanName: 'Бета' },
    ]);
  });

  it('returns empty clanPriority array when no clan has an active priority member', async () => {
    const db = makeDb([], [], []);
    const { clanPriority } = await snapshotRolesAndAdmins(db);
    expect(clanPriority).toEqual([]);
  });
});
