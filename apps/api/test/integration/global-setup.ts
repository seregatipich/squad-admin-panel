import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { buildSharedTemplate, testDbUrl, useRunId } from './isolated-db.js';

/**
 * Drops every `sqtest_`/`sqtmpl_`/`sqworker_` database created by this run —
 * i.e. carrying this run's own `runId` — leaving any concurrently running
 * session's databases (a different `runId`) untouched. `pg_database` and
 * `DROP DATABASE` are cluster-wide, so an unscoped sweep here would otherwise
 * race and destroy another local session's still-live databases (#212).
 */
export async function dropTestDatabases(runId: string): Promise<void> {
  const sql = postgres(testDbUrl, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql<{ datname: string }[]>`
      SELECT datname FROM pg_database
      WHERE datname LIKE ${`sqtest_${runId}_%`}
         OR datname LIKE ${`sqtmpl_${runId}_%`}
         OR datname LIKE ${`sqworker_${runId}_%`}`;
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
  const runId = randomBytes(4).toString('hex');
  useRunId(runId);
  provide('squadRunId', runId);
  await dropTestDatabases(runId);
  const template = await buildSharedTemplate();
  provide('squadTemplateDb', template);
  return async () => {
    await dropTestDatabases(runId);
  };
}
