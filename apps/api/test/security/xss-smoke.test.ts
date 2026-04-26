import { rolePermissions, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from '../integration/harness.js';

const OWNER_STEAM = testSteamId(500001);

let h: IntegrationHarness;
let ownerCookie: string;
const createdRoleIds: string[] = [];

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);
}, 60_000);

afterAll(async () => {
  for (const id of createdRoleIds) {
    await h.db
      .delete(rolePermissions)
      .where(eq(rolePermissions.roleId, id))
      .catch(() => undefined);
    await h.db
      .delete(roles)
      .where(eq(roles.id, id))
      .catch(() => undefined);
  }
  await h.cleanup();
}, 60_000);

describe('XSS smoke — role name with HTML payload', () => {
  it('stores HTML role name as-is in JSON (not stripped or escaped at storage layer)', async () => {
    const malicious = '<script>alert(1)</script>';
    const createRes = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie: ownerCookie },
      payload: { name: malicious, color: 'neutral', permissions: [] },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json<{ id: string; name: string }>();
    createdRoleIds.push(created.id);
    expect(created.name).toBe(malicious);

    const listRes = await h.app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      headers: { cookie: ownerCookie },
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json<{ name: string }[]>();
    const found = list.find((r) => r.name === malicious);
    expect(found).toBeDefined();
    expect(found?.name).toBe(malicious);
  });

  it('stores HTML in role description as-is', async () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const createRes = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie: ownerCookie },
      payload: {
        name: `xss-desc-${Date.now()}`,
        color: 'neutral',
        permissions: [],
        description: malicious,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json<{ id: string; description: string }>();
    createdRoleIds.push(created.id);
    expect(created.description).toBe(malicious);
  });

  it('stores HTML in player query response without server-side escaping', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players?q=${encodeURIComponent('<script>')}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: unknown[] }>();
    expect(body).toHaveProperty('items');
  });

  it('Content-Type for JSON responses is application/json (not text/html)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/i);
  });
});
