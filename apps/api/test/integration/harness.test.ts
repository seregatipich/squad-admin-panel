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
  it('builds an app against a fresh schema + seeds an owner', async () => {
    current = await buildIntegrationApp({
      seedOwner: { steamId64: 76561198000000001n },
    });
    expect(typeof current.seed.ownerSteamId64).toBe('bigint');
    expect(current.schema).toMatch(/^test_[0-9a-f]{12}$/);
    const meRes = await current.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect([200, 401]).toContain(meRes.statusCode);
  }, 30_000);

  it('cleanup drops the schema', async () => {
    const h = await buildIntegrationApp();
    const schema = h.schema;
    await h.cleanup();
    const { testDbUrl } = await import('./harness.js');
    const pg = (await import('postgres')).default(testDbUrl, { max: 1 });
    const rows = await pg<
      { nspname: string }[]
    >`select nspname from pg_namespace where nspname = ${schema}`;
    await pg.end();
    expect(rows).toHaveLength(0);
  }, 30_000);
});
