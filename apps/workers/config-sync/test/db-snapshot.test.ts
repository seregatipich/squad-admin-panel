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
    const db = makeDb([], [{ steam_id64: '76561198000000001', role_name: 'Admin' }]);
    const { roles, admins } = await snapshotRolesAndAdmins(db);
    expect(roles).toEqual([]);
    expect(admins).toEqual([{ steamId64: '76561198000000001', roleName: 'Admin' }]);
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
        { steam_id64: '76561198000000001', role_name: 'Admin' },
        { steam_id64: '76561198000000002', role_name: 'Mod' },
      ],
    );
    const { roles, admins } = await snapshotRolesAndAdmins(db);
    expect(roles).toHaveLength(2);
    expect(admins).toHaveLength(2);
    expect(admins[0]).toEqual({ steamId64: '76561198000000001', roleName: 'Admin' });
    expect(admins[1]).toEqual({ steamId64: '76561198000000002', roleName: 'Mod' });
  });
});
