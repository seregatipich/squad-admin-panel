import { organizationMembers, organizations, userRoleAssignments, users } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './harness.js';

let h: IntegrationHarness;

afterEach(async () => {
  if (h) await h.cleanup();
});

describe('GET /api/v1/setup/check-env', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({ bridge: makeFakeBridge() });
  });

  it('returns ok=true when the bridge hostInfo reports Ubuntu', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/setup/check-env' });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ ok: boolean; checks: Record<string, { ok: boolean }> }>();
    expect(body.ok).toBe(true);
    expect(body.checks.bridge.ok).toBe(true);
    expect(body.checks.host.ok).toBe(true);
  });

  it('surfaces a bridge ping failure as ok=false', async () => {
    await h.cleanup();
    h = await buildIntegrationApp({
      bridge: makeFakeBridge({
        hostInfo: async () => {
          throw new Error('socket closed');
        },
      }),
    });
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/setup/check-env' });
    const body = resp.json<{
      ok: boolean;
      checks: Record<string, { ok: boolean; detail?: string }>;
    }>();
    expect(body.ok).toBe(false);
    expect(body.checks.bridge.ok).toBe(false);
  });
});

describe('POST /api/v1/setup/org + /owner + /finalize', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({ bridge: makeFakeBridge() });
  });

  it('creates an organization and seeds system roles', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/org',
      payload: { name: 'Acme Squad' },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ org_id: string; slug: string; system_roles: unknown[] }>();
    expect(body.slug).toBe('acme-squad');
    expect(body.system_roles).toHaveLength(4);
    await assertAuditRow(h, { action: 'setup.org.create', resource: 'organization' });
  });

  it('honours a custom slug and validates it', async () => {
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/org',
      payload: { name: 'X', slug: 'my-custom-slug' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ slug: string }>().slug).toBe('my-custom-slug');

    await h.cleanup();
    h = await buildIntegrationApp({ bridge: makeFakeBridge() });
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/org',
      payload: { name: 'X', slug: 'UPPERCASE' },
    });
    expect([400, 422]).toContain(bad.statusCode);
  });

  it('/owner before /org is 400 no_organization_yet', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/owner',
      payload: {
        email: 'owner@test.local',
        display_name: 'Owner',
        password: 'correct-horse-battery-staple',
      },
    });
    expect(resp.statusCode).toBe(400);
    expect(resp.json()).toEqual({ error: 'no_organization_yet' });
  });

  it('/owner inserts user + assigns Owner role + is hashed', async () => {
    await h.app.inject({ method: 'POST', url: '/api/v1/setup/org', payload: { name: 'Acme' } });
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/owner',
      payload: {
        email: 'owner@test.local',
        display_name: 'Owner',
        password: 'correct-horse-battery-staple',
      },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ user_id: string; email: string }>();
    expect(body.email).toBe('owner@test.local');

    const [user] = await h.db.select().from(users).where(eq(users.email, body.email));
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);

    const assignments = await h.db
      .select()
      .from(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, body.user_id));
    expect(assignments).toHaveLength(1);

    const membership = await h.db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, body.user_id));
    expect(membership).toHaveLength(1);

    await assertAuditRow(h, { action: 'setup.owner.create', resource: 'user' });
  });

  it('/owner with duplicate email is 409', async () => {
    await h.app.inject({ method: 'POST', url: '/api/v1/setup/org', payload: { name: 'Acme' } });
    const body = {
      email: 'dup@test.local',
      display_name: 'Dup',
      password: 'correct-horse-battery-staple',
    };
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/owner',
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/owner',
      payload: body,
    });
    expect(second.statusCode).toBe(409);
  });

  it('/finalize flips setup_complete=true and subsequent /check-env is 410', async () => {
    await h.app.inject({ method: 'POST', url: '/api/v1/setup/org', payload: { name: 'Acme' } });
    const resp = await h.app.inject({ method: 'POST', url: '/api/v1/setup/finalize', payload: {} });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ ok: true });
    await assertAuditRow(h, { action: 'setup.finalize', resource: 'organization' });

    const [org] = await h.db.select().from(organizations);
    expect((org?.settings as { setup_complete?: boolean } | undefined)?.setup_complete).toBe(true);

    const checkEnv = await h.app.inject({ method: 'GET', url: '/api/v1/setup/check-env' });
    expect(checkEnv.statusCode).toBe(410);
  });
});

describe('GET /api/v1/host/* and /api/v1/permissions', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { email: 'owner@test.local', password: 'correct-horse-battery-staple' },
      bridge: makeFakeBridge(),
    });
  });

  it('/permissions returns 4 system roles and the permission registry', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/permissions' });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ permissions: string[]; roles: Array<{ name: string }> }>();
    expect(body.permissions).toContain('server:view');
    expect(body.roles.map((r) => r.name).sort()).toEqual([
      'Admin',
      'Owner',
      'Senior Admin',
      'Viewer',
    ]);
  });

  it('/host/info forwards fake bridge hostInfo behind auth', async () => {
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/info',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json<{ os_name: string }>().os_name).toBe('Ubuntu');
  });

  it('/host/metrics requires auth and returns metrics', async () => {
    const anon = await h.app.inject({ method: 'GET', url: '/api/v1/host/metrics' });
    expect(anon.statusCode).toBe(401);
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/metrics',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<Record<string, unknown>>();
    expect(body.cpu_percent).toBeDefined();
  });

  it('/host/bridge-status reports connected=true on ping; false on throw', async () => {
    const okCookie = await login();
    const ok = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/bridge-status',
      headers: { cookie: okCookie },
    });
    expect(ok.json<{ connected: boolean }>().connected).toBe(true);

    await h.cleanup();
    h = await buildIntegrationApp({
      seedOwner: { email: 'owner@test.local', password: 'correct-horse-battery-staple' },
      bridge: makeFakeBridge({
        ping: async () => {
          throw new Error('socket gone');
        },
      }),
    });
    const downCookie = await login();
    const down = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/bridge-status',
      headers: { cookie: downCookie },
    });
    expect(down.json<{ connected: boolean; error: string }>()).toEqual({
      connected: false,
      error: 'socket gone',
    });
  });
});

describe('GET /api/v1/audit', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { email: 'owner@test.local', password: 'correct-horse-battery-staple' },
      bridge: makeFakeBridge(),
    });
  });

  it('paginates in created-desc order and serializes bigint id as string', async () => {
    const cookie = await login();
    // Emit a couple of audit rows by hitting audited endpoints.
    await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    // Re-login to generate another audit row.
    const cookie2 = await login();
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookie2 },
    });

    // Small delay so onResponse audit hook completes.
    await new Promise((r) => setTimeout(r, 150));

    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit?page=1&page_size=10',
      headers: { cookie: cookie2 },
    });
    expect(resp.statusCode).toBe(401); // session revoked
    const freshCookie = await login();
    // The audit row for the fresh login is written by the onResponse hook
    // asynchronously — give it a beat before reading or the audit list may
    // be ordered with the previous logout still on top (its hook fired
    // first).
    await new Promise((r) => setTimeout(r, 150));
    const ok = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit?page=1&page_size=10',
      headers: { cookie: freshCookie },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{
      items: Array<{ id: string; action_type: string }>;
      page: number;
      page_size: number;
    }>();
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(10);
    expect(body.items.length).toBeGreaterThan(0);
    expect(typeof body.items[0]?.id).toBe('string');
    // Newest row first.
    expect(body.items[0]?.action_type).toBe('user.login');
  });
});

async function login(
  email = 'owner@test.local',
  password = 'correct-horse-battery-staple',
): Promise<string> {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (resp.statusCode !== 200) throw new Error(`login failed: ${resp.body}`);
  const raw = Array.isArray(resp.headers['set-cookie'])
    ? resp.headers['set-cookie'][0]!
    : (resp.headers['set-cookie'] as string);
  return raw.match(/(__Host-sid=[^;]+)/)?.[1]!;
}
