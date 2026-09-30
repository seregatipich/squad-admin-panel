import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

const BLOCKED_POLL_INTERVAL_MS = 20;

/**
 * Polls `pg_stat_activity` until some backend of the current database waits on a lock
 * another session holds — i.e. the request under test reached a statement
 * that conflicts with the transaction the test keeps open.
 *
 * @throws Error when nothing blocks within `timeoutMs`.
 */
export async function waitForBlockedBackend(db: DatabaseClient, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c
      FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND datname = current_database()
    `);
    if ((rows[0]?.c ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, BLOCKED_POLL_INTERVAL_MS));
  }
  throw new Error('no backend became blocked on a lock');
}

/**
 * Reproduces a read-then-write race deterministically: `mutate` runs inside a
 * transaction that stays open (holding its row locks) while `request` starts,
 * until `request` blocks on those locks; the transaction then commits and the
 * request resumes against the committed state.
 *
 * The open transaction and the lock polling use their own connections (from
 * `databaseUrl`, the harness `url`), because the harness pool that serves the
 * app holds only two.
 *
 * @returns Whatever `request` resolves to.
 */
export async function raceAgainstOpenTransaction<T>(
  databaseUrl: string,
  mutate: (tx: Transaction) => Promise<void>,
  request: () => Promise<T>,
): Promise<T> {
  const client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  const db = drizzle(client, { schema }) as unknown as DatabaseClient;
  try {
    return await raceWith(db, mutate, request);
  } finally {
    await client.end();
  }
}

async function raceWith<T>(
  db: DatabaseClient,
  mutate: (tx: Transaction) => Promise<void>,
  request: () => Promise<T>,
): Promise<T> {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalMutated: () => void = () => {};
  const mutated = new Promise<void>((resolve) => {
    signalMutated = resolve;
  });
  const transaction = db.transaction(async (tx) => {
    await mutate(tx);
    signalMutated();
    await released;
  });
  await mutated;

  const pending = request();
  let blockError: unknown = null;
  try {
    await waitForBlockedBackend(db);
  } catch (err) {
    blockError = err;
  }
  release();
  await transaction;
  const result = await pending;
  if (blockError) throw blockError;
  return result;
}

/**
 * Makes every `audit_log` insert with the given `action_type` raise, for the
 * duration of `fn` — proves a mutation and its audit row commit atomically.
 */
export async function withFailingAuditInsert<T>(
  db: DatabaseClient,
  actionType: string,
  fn: () => Promise<T>,
): Promise<T> {
  const name = `test_fail_audit_${actionType.replace(/[^a-z0-9]/gi, '_')}`;
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action_type = '${actionType}' THEN
          RAISE EXCEPTION 'audit insert forced to fail';
        END IF;
        RETURN NEW;
      END $$`),
  );
  await db.execute(
    sql.raw(
      `CREATE TRIGGER ${name} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    ),
  );
  try {
    return await fn();
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON audit_log`));
    await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
  }
}
