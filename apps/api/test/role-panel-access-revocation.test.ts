import { players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM = 76561198000001500n;
const MEMBER_STEAM = 76561198000001501n;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('role loses panel_access: member sessions', () => {
  let h: IntegrationHarness;
  let roleId: string;
  let memberId: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM },
      seedOwnerGuard: true,
      bridge: makeFakeBridge(),
    });
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  beforeEach(async () => {
    roleId = uuidv7();
    await h.db
      .insert(roles)
      .values({ id: roleId, name: `panel-${roleId}`, color: 'blue', panelAccess: true });
    const [member] = await h.db
      .insert(players)
      .values({
        steamId64: MEMBER_STEAM,
        canonicalName: 'Panel Member',
        canonicalNameNormalized: 'panel member',
        roleId,
      })
      .onConflictDoUpdate({ target: players.steamId64, set: { roleId } })
      .returning({ id: players.id });
    if (!member) throw new Error('member missing');
    memberId = member.id;
    invalidatePermissionCache(memberId);
  });

  async function memberCookie(): Promise<string> {
    const { token } = await createSession(h.db, h.redis, {
      playerId: memberId,
      ip: null,
      userAgent: 'test-harness',
      ttlMs: 21_600_000,
    });
    return `__Host-sid=${token}`;
  }

  async function listIssuesStatus(cookie: string): Promise<number> {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/issues', headers: { cookie } });
    return res.statusCode;
  }

  it('member session works while the role grants panel_access', async () => {
    expect(await listIssuesStatus(await memberCookie())).toBe(200);
  });

  it('PUT panel_access=false makes an existing session unauthenticated', async () => {
    const ownerCookie = await loginAsOwner(h);
    const cookie = await memberCookie();
    expect(await listIssuesStatus(cookie)).toBe(200);

    const patch = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${roleId}`,
      headers: { cookie: ownerCookie },
      payload: { panel_access: false },
    });
    expect(patch.statusCode).toBe(200);

    expect(await listIssuesStatus(cookie)).toBe(401);
  });

  it('DELETE role makes an existing session unauthenticated', async () => {
    const ownerCookie = await loginAsOwner(h);
    const cookie = await memberCookie();

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/roles/${roleId}`,
      headers: { cookie: ownerCookie },
    });
    expect(del.statusCode).toBe(200);

    expect(await listIssuesStatus(cookie)).toBe(401);
  });

  it('a panel-scoped session is rejected once panel_access is lost, even without revocation', async () => {
    const cookie = await memberCookie();
    await h.db.update(roles).set({ panelAccess: false }).where(eq(roles.id, roleId));
    invalidatePermissionCache(memberId);

    expect(await listIssuesStatus(cookie)).toBe(401);
  });
});
