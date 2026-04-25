import { organizations } from '@squad/db/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = 76561198000000999n;

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

describe('POST /api/v1/setup/init', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({ bridge: makeFakeBridge() });
  });

  it('creates an organization and seeds system roles', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/init',
      payload: { name: 'Acme Squad' },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json<{ org_id: string; slug: string }>();
    expect(body.slug).toBe('acme-squad');
    await assertAuditRow(h, { action: 'setup.init', resource: 'organization' });
  });

  it('honours a custom slug and validates it', async () => {
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/init',
      payload: { name: 'X', slug: 'my-custom-slug' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ slug: string }>().slug).toBe('my-custom-slug');

    await h.cleanup();
    h = await buildIntegrationApp({ bridge: makeFakeBridge() });
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/init',
      payload: { name: 'X', slug: 'UPPERCASE' },
    });
    expect([400, 422]).toContain(bad.statusCode);
  });

  it('/init flips setup_complete=true and subsequent /check-env is 410', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/init',
      payload: { name: 'Acme' },
    });
    expect(resp.statusCode).toBe(200);

    const [org] = await h.db.select().from(organizations);
    expect((org?.settings as { setup_complete?: boolean } | undefined)?.setup_complete).toBe(true);

    const checkEnv = await h.app.inject({ method: 'GET', url: '/api/v1/setup/check-env' });
    expect(checkEnv.statusCode).toBe(410);
  });
});

describe('GET /api/v1/host/* and /api/v1/permissions', () => {
  beforeEach(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
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
    const cookie = await loginAsOwner(h);
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
    const cookie = await loginAsOwner(h);
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
    const okCookie = await loginAsOwner(h);
    const ok = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/bridge-status',
      headers: { cookie: okCookie },
    });
    expect(ok.json<{ connected: boolean }>().connected).toBe(true);

    await h.cleanup();
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge({
        ping: async () => {
          throw new Error('socket gone');
        },
      }),
    });
    const downCookie = await loginAsOwner(h);
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
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
    });
  });

  it('paginates in created-desc order and serializes bigint id as string', async () => {
    const cookie = await loginAsOwner(h);
    await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });

    await new Promise((r) => setTimeout(r, 150));

    const freshCookie = await loginAsOwner(h);
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
    expect(body.items[0]?.action_type).toBe('user.logout');
  });
});
