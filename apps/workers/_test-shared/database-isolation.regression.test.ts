/**
 * Guards the test harness every database-backed package relies on, once for all
 * of them: each package's Vitest config lists this file in `include`, so it runs
 * with that package as the Vitest root.
 *
 * Without the per-slot database clone and the per-slot Redis logical database,
 * files that run in parallel share rows, streams and heartbeat keys and fail
 * intermittently. The package name is read from the root directory because the
 * template database is named after it (`sqworker_<run>_<package>`).
 */
import path from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { describeIfDb, describeIfRedis } from '../../../packages/db/test/helpers/describe-if.js';

const packageName = path.basename(process.cwd());
const DATABASE_URL = process.env.DATABASE_URL;
// packages/db has no Redis dependency and its Vitest setup never assigns a Redis database.
const usesRedis = packageName !== 'db';

describeIfDb(`${packageName} package resource isolation`, () => {
  it("runs against its worker slot's clone of the run's crash-recoverable template", () => {
    if (!DATABASE_URL) throw new Error(`${packageName} test database was not provisioned`);
    const templateUrl = inject('squadPackageTemplateUrl');
    if (!templateUrl) throw new Error(`${packageName} package template was not provided`);
    const template = new URL(templateUrl).pathname.slice(1);
    expect(template).toMatch(
      new RegExp(`^sqworker_[0-9a-f]{12}_${packageName.replaceAll('-', '_')}$`),
    );
    expect(new URL(DATABASE_URL).pathname).toBe(`/${template}__w${process.env.VITEST_POOL_ID}`);
    expect(process.env.TEST_DATABASE_URL).toBe(DATABASE_URL);
  });
});

// The setup files assign a Redis database only when a Redis is configured (#120): without
// REDIS_URL the suite is skipped locally and refused under CI, like every Redis suite.
const describeRedisIsolation = usesRedis ? describeIfRedis : describe.skip;

describeRedisIsolation(`${packageName} package Redis isolation`, () => {
  it("points every Redis setting at its worker slot's own logical database", () => {
    const database = String(1 + ((Number(process.env.VITEST_POOL_ID) - 1) % 7));
    expect(process.env.TEST_REDIS_DB).toBe(database);
    expect(new URL(process.env.REDIS_URL ?? '').pathname).toBe(`/${database}`);
    expect(new URL(process.env.TEST_REDIS_URL ?? '').pathname).toBe(`/${database}`);
  });
});
