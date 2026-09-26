import postgres from 'postgres';
import { describe, expect, inject, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('rcon package resource isolation', () => {
  it("runs against its worker slot's clone of the run's crash-recoverable template", async () => {
    if (!DATABASE_URL) throw new Error('rcon test database was not provisioned');
    const templateUrl = inject('squadPackageTemplateUrl');
    if (!templateUrl) throw new Error('rcon package template was not provided');
    const template = new URL(templateUrl).pathname.slice(1);
    expect(template).toMatch(/^sqworker_[0-9a-f]{12}_rcon$/);

    const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    try {
      const [row] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      expect(row?.name).toBe(`${template}__w${process.env.VITEST_POOL_ID}`);
    } finally {
      await sql.end();
    }
  });
});

describe('rcon package Redis isolation', () => {
  it("points every Redis setting at its worker slot's own logical database", () => {
    const database = String(1 + ((Number(process.env.VITEST_POOL_ID) - 1) % 7));
    expect(process.env.TEST_REDIS_DB).toBe(database);
    expect(new URL(process.env.REDIS_URL ?? '').pathname).toBe(`/${database}`);
    expect(new URL(process.env.TEST_REDIS_URL ?? '').pathname).toBe(`/${database}`);
  });
});
