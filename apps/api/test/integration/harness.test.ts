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
      seedOwner: { email: 'owner@test.local', password: 'correct-horse-battery-staple' },
    });
    expect(current.seed.orgId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(current.seed.ownerUserId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(current.schema).toMatch(/^test_[0-9a-f]{12}$/);
    const healthOr404 = await current.app.inject({ method: 'GET', url: '/api/v1/setup/check-env' });
    expect([200, 410]).toContain(healthOr404.statusCode);
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
