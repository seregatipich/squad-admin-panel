import { describe, expect, it } from 'vitest';
import { buildManagedSegment } from '../src/segment.js';

// ECON-6 (#166): a privilege purchased in the bonus shop grants the tier's role
// (players.role_id + role_expires_at) and enqueues an admins-cfg sync with
// reason `player.role.assign`. The syncer then rebuilds the managed segment
// from roles + active grants, so a purchased grant must render as an `Admin=`
// line exactly like any other role assignment.
describe('purchased grant → Admins.cfg managed segment (ECON-6)', () => {
  it('a purchased grant renders as an Admin= line in the managed segment', () => {
    const out = buildManagedSegment({
      roles: [
        { name: 'VipBronze', squadPermissions: ['reserve'] },
        { name: 'Admin', squadPermissions: ['kick', 'ban'] },
      ],
      admins: [
        // The buyer, holding the tier's role after the purchase transaction.
        { eosId: '0002e50586d9414e8e15c66eb3dbf70e', roleName: 'VipBronze' },
        { eosId: '0002a10186d9414e8e15c66eb3dbf70a', roleName: 'Admin' },
      ],
    });

    expect(out.body).toContain('Group=VipBronze:reserve');
    const adminLines = out.body
      .split('\r\n')
      .filter((l) => l.startsWith('Admin='))
      .map((l) => l.replace('Admin=', ''));
    expect(adminLines).toContain('0002e50586d9414e8e15c66eb3dbf70e:VipBronze');
    expect(out.adminsCount).toBe(2);
  });

  it('an expired purchase no longer contributes an Admin= line once the grant is dropped', () => {
    // After role-expirer clears the lapsed grant the buyer disappears from the
    // syncer's admin inputs; the role's Group= line survives for other holders.
    const out = buildManagedSegment({
      roles: [{ name: 'VipBronze', squadPermissions: ['reserve'] }],
      admins: [],
    });
    expect(out.body).toContain('Group=VipBronze:reserve');
    expect(out.body.split('\r\n').filter((l) => l.startsWith('Admin='))).toEqual([]);
    expect(out.adminsCount).toBe(0);
  });
});
