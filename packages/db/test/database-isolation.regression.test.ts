import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('db package resource isolation', () => {
  it('runs against a dedicated crash-recoverable database', async () => {
    if (!DATABASE_URL) throw new Error('db test database was not provisioned');

    const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    try {
      const [row] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      expect(row?.name).toMatch(/^sqworker_[0-9a-f]{12}_db$/);
    } finally {
      await sql.end();
    }
  });
});
