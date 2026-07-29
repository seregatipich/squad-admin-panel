import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dropTestDatabases } from './global-setup.js';
import { testDbUrl } from './isolated-db.js';

describe('global-setup dropTestDatabases', () => {
  it("drops only its own run-id leftovers, never a concurrent run's databases", async () => {
    const pg = (await import('postgres')).default(testDbUrl, { max: 1, onnotice: () => undefined });
    const myRunId = randomBytes(4).toString('hex');
    const otherRunId = randomBytes(4).toString('hex');
    const mine = `sqtest_${myRunId}_leftover`;
    const theirs = `sqworker_${otherRunId}_leftover`;
    try {
      await pg.unsafe(`CREATE DATABASE "${mine}"`);
      await pg.unsafe(`CREATE DATABASE "${theirs}"`);

      await dropTestDatabases(myRunId);

      const rows = await pg<
        { datname: string }[]
      >`select datname from pg_database where datname in (${mine}, ${theirs}) order by datname`;
      expect(rows.map((r) => r.datname)).toEqual([theirs]);
    } finally {
      await pg.unsafe(`DROP DATABASE IF EXISTS "${mine}" WITH (FORCE)`).catch(() => undefined);
      await pg.unsafe(`DROP DATABASE IF EXISTS "${theirs}" WITH (FORCE)`).catch(() => undefined);
      await pg.end();
    }
  }, 30_000);
});
