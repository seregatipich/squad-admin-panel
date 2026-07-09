import postgres from 'postgres';
import { testDbUrl } from './harness.js';

async function dropTestDatabases(): Promise<void> {
  const sql = postgres(testDbUrl, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql<{ datname: string }[]>`
      SELECT datname FROM pg_database
      WHERE datname LIKE 'sqtest_%' OR datname LIKE 'sqtmpl_%'`;
    for (const { datname } of rows) {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => undefined);
    }
  } finally {
    await sql.end();
  }
}

export async function setup(): Promise<void> {
  await dropTestDatabases();
}

export async function teardown(): Promise<void> {
  await dropTestDatabases();
}
