import { describe, expect, it, vi } from 'vitest';
import { snapshotRolesAndAdmins } from '../src/db-snapshot.js';

function makeDb(roleRows: unknown[], adminRows: unknown[]) {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(() => {
      const result = callIndex === 0 ? roleRows : adminRows;
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
    const { roles, admins } = await snapshotRolesAndAdmins(db);
    expect(roles).toEqual([]);
    expect(admins).toEqual([]);
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
});
