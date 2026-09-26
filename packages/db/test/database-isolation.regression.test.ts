import postgres from 'postgres';
import { describe, expect, inject, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('db package resource isolation', () => {
  it("runs against its worker slot's clone of the run's crash-recoverable template", async () => {
    if (!DATABASE_URL) throw new Error('db test database was not provisioned');
    const templateUrl = inject('squadPackageTemplateUrl');
    if (!templateUrl) throw new Error('db package template was not provided');

    const template = new URL(templateUrl).pathname.slice(1);
    expect(template).toMatch(/^sqworker_[0-9a-f]{12}_db$/);

    const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    try {
      const [row] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      expect(row?.name).toBe(`${template}__w${process.env.VITEST_POOL_ID}`);
      expect(process.env.TEST_DATABASE_URL).toBe(DATABASE_URL);
    } finally {
      await sql.end();
    }
  });
});
