import postgres from 'postgres';
import { buildSharedTemplate, testDbUrl } from './isolated-db.js';

async function dropTestDatabases(): Promise<void> {
  const sql = postgres(testDbUrl, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql<{ datname: string }[]>`
      SELECT datname FROM pg_database
      WHERE datname LIKE 'sqtest_%' OR datname LIKE 'sqtmpl_%' OR datname LIKE 'sqworker_%'`;
    for (const { datname } of rows) {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => undefined);
    }
  } finally {
    await sql.end();
  }
}

export default async function ({
  provide,
}: {
  provide: (key: string, value: unknown) => void;
}): Promise<() => Promise<void>> {
  await dropTestDatabases();
  const template = await buildSharedTemplate();
  provide('squadTemplateDb', template);
  return async () => {
    await dropTestDatabases();
  };
}
