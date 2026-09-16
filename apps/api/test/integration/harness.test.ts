import { afterEach, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness } from './harness.js';

let current: IntegrationHarness | null = null;

afterEach(async () => {
  if (current) {
    await current.cleanup();
    current = null;
  }
});

describe('integration harness', () => {
  it('builds an app against a fresh database + seeds an owner', async () => {
    current = await buildIntegrationApp({
      seedOwner: { steamId64: 76561198000000001n },
    });
    expect(typeof current.seed.ownerSteamId64).toBe('bigint');
    expect(current.schema).toMatch(/^sqtest_[0-9a-f]{8}_[0-9a-f]{12}$/);
    const meRes = await current.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect([200, 401]).toContain(meRes.statusCode);
  }, 30_000);

  it('GET /api/v1/auth/steam/login resolves through the shared registerRoutes() (regression, #207)', async () => {
    current = await buildIntegrationApp();
    const steam = await current.app.inject({ method: 'GET', url: '/api/v1/auth/steam/login' });
    const removedBss = await current.app.inject({ method: 'GET', url: '/api/v1/auth/bss/login' });

    expect(steam.statusCode).toBe(302);
    expect(steam.headers.location).toContain('steamcommunity.com/openid/login');
    // No such route any more: the fail-closed auth floor answers before routing.
    expect([401, 404]).toContain(removedBss.statusCode);
  }, 30_000);

  it('cleanup drops the database', async () => {
    const h = await buildIntegrationApp();
    const database = h.schema;
    await h.cleanup();
    const { testDbUrl } = await import('./harness.js');
    const pg = (await import('postgres')).default(testDbUrl, { max: 1 });
    const rows = await pg<
      { datname: string }[]
    >`select datname from pg_database where datname = ${database}`;
    await pg.end();
    expect(rows).toHaveLength(0);
  }, 30_000);
});
