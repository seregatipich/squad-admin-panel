import { snapshotRolesAndAdmins } from '@squad/db';
import { clans, players, roleSquadPermissions, roles } from '@squad/db/schema';
import { buildManagedSegmentBody } from '@squad/shared-config/admins-config';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

/**
 * Issue #11: values that end up in Admins.cfg (role names, assignment
 * comments, clan names) must be rejected by the API when they would change
 * the file's line structure, and accepted when they are ordinary text.
 */

const OWNER_STEAM = testSteamId(911001);
const MEMBER_STEAM = testSteamId(911002);
const INJECTED_EOS = '0002ffffffffffffffffffffffffffff';
const MEMBER_EOS = '0002a10186d9414e8e15c66eb3dbf711';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let cookie: string;
let memberPlayerId: string;
let assignableRoleId: string;

function jsonHeaders() {
  return { cookie, 'content-type': 'application/json' };
}

async function storedComment(): Promise<string | null> {
  const [row] = await h.db
    .select({ roleComment: players.roleComment })
    .from(players)
    .where(eq(players.steamId64, MEMBER_STEAM));
  return row?.roleComment ?? null;
}

describeIfDb('Admins.cfg injection guards on the API (issue #11)', () => {
  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      bridge: makeFakeBridge(),
    });
    cookie = await loginAsOwner(h);

    assignableRoleId = uuidv7();
    await h.db.insert(roles).values({ id: assignableRoleId, name: 'InjectionGuardRole' });
    await h.db
      .insert(roleSquadPermissions)
      .values({ roleId: assignableRoleId, squadPermissionKey: 'kick' });
    const [member] = await h.db
      .insert(players)
      .values({
        steamId64: MEMBER_STEAM,
        canonicalName: 'Injection Guard Member',
        canonicalNameNormalized: 'injection guard member',
        eosId: MEMBER_EOS,
      })
      .returning({ id: players.id });
    if (!member) throw new Error('member fixture was not inserted');
    memberPlayerId = member.id;
  });

  afterAll(async () => {
    if (h?.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
    await h?.cleanup();
  });

  describe('role name', () => {
    it.each([
      ['CR/LF', `X:ban\r\nAdmin=${INJECTED_EOS}:X\r\nGroup=Y`],
      ['colon', 'A:ban'],
      ['comma', 'A,B'],
      ['end marker', 'A//SQUAD-PANEL END'],
      ['unicode line separator', 'A B'],
      ['blank', '   '],
    ])('POST /api/v1/roles rejects a name with %s', async (_label, name) => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        headers: jsonHeaders(),
        payload: { name, color: 'blue', squad_permissions: ['kick'] },
      });
      expect(res.statusCode).toBe(400);
      const stored = await h.db.select({ id: roles.id }).from(roles).where(eq(roles.name, name));
      expect(stored).toEqual([]);
    });

    it('PUT /api/v1/roles/:id rejects a CR/LF rename and keeps the old name', async () => {
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/roles/${assignableRoleId}`,
        headers: jsonHeaders(),
        payload: { name: `Z\r\nAdmin=${INJECTED_EOS}:Z` },
      });
      expect(res.statusCode).toBe(400);
      const [row] = await h.db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, assignableRoleId));
      expect(row?.name).toBe('InjectionGuardRole');
    });

    it('POST /api/v1/roles still accepts a Cyrillic name with a space', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        headers: jsonHeaders(),
        payload: { name: 'Старший админ', color: 'blue', squad_permissions: ['kick'] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: 'Старший админ' });
    });
  });

  describe('assignment comment', () => {
    it.each([
      ['CR/LF', `x\r\nAdmin=${INJECTED_EOS}:Owner`],
      ['bare LF', `x\nAdmin=${INJECTED_EOS}:Owner`],
      ['unicode line separator', `x Admin=${INJECTED_EOS}:Owner`],
    ])('PUT /api/v1/players/:id/role rejects a comment with %s', async (_label, comment) => {
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/players/${memberPlayerId}/role`,
        headers: jsonHeaders(),
        payload: { role_id: assignableRoleId, comment },
      });
      expect(res.statusCode).toBe(400);
      expect(await storedComment()).toBeNull();
    });

    it('POST /api/v1/roles/:id/members rejects a comment with CR/LF', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/roles/${assignableRoleId}/members`,
        headers: jsonHeaders(),
        payload: {
          player_id: memberPlayerId,
          comment: `x\r\nAdmin=${INJECTED_EOS}:Owner\r\n//SQUAD-PANEL END`,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(await storedComment()).toBeNull();
    });

    it('accepts an ordinary single-line comment and writes it into the managed segment', async () => {
      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/players/${memberPlayerId}/role`,
        headers: jsonHeaders(),
        payload: { role_id: assignableRoleId, comment: 'выдано до 01.01: см. тикет' },
      });
      expect(res.statusCode).toBe(200);
      expect(await storedComment()).toBe('выдано до 01.01: см. тикет');

      const snapshot = await snapshotRolesAndAdmins(h.db);
      const { body } = buildManagedSegmentBody(snapshot);
      expect(body.split('\r\n')).toContain(
        `Admin=${MEMBER_EOS}:InjectionGuardRole // выдано до 01.01: см. тикет`,
      );
      expect(body).not.toContain(INJECTED_EOS);
    });
  });

  describe('clan name', () => {
    it('POST /api/v1/clans rejects a name with CR/LF', async () => {
      const name = 'C\r\n//SQUAD-PANEL END';
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/clans',
        headers: jsonHeaders(),
        payload: { name },
      });
      expect(res.statusCode).toBe(400);
      const stored = await h.db.select({ id: clans.id }).from(clans).where(eq(clans.name, name));
      expect(stored).toEqual([]);
    });

    it('PATCH /api/v1/clans/:id rejects a CR/LF rename and keeps the old name', async () => {
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/v1/clans',
        headers: jsonHeaders(),
        payload: { name: 'Альфа' },
      });
      expect(created.statusCode).toBe(201);
      const { id } = created.json() as { id: string };

      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/clans/${id}`,
        headers: jsonHeaders(),
        payload: { name: 'Альфа //SQUAD-PANEL END' },
      });
      expect(res.statusCode).toBe(400);
      const [row] = await h.db.select({ name: clans.name }).from(clans).where(eq(clans.id, id));
      expect(row?.name).toBe('Альфа');
    });
  });
});
