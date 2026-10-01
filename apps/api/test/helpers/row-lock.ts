import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

const BLOCKED_POLL_INTERVAL_MS = 20;

/**
 * Polls `pg_stat_activity` until `minBlocked` backends of the current database
 * wait on a lock another session holds — i.e. the requests under test reached
 * statements that conflict with the transaction the test keeps open.
 *
 * @param db - Connection used for the polling query (not one the requests use).
 * @param timeoutMs - How long to wait for the backends to block.
 * @param minBlocked - How many waiting backends to wait for; defaults to 1.
 * @throws Error when fewer than `minBlocked` backends block within `timeoutMs`.
 */
export async function waitForBlockedBackend(
  db: DatabaseClient,
  timeoutMs = 3000,
  minBlocked = 1,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c
      FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND datname = current_database()
    `);
    if ((rows[0]?.c ?? 0) >= minBlocked) return;
    await new Promise((resolve) => setTimeout(resolve, BLOCKED_POLL_INTERVAL_MS));
  }
  throw new Error('no backend became blocked on a lock');
}

/**
 * {@link waitForBlockedBackend} over its own short-lived connection to
 * `databaseUrl`, for tests whose harness pool has no free connection left to
 * poll with while the app and the open transaction hold theirs.
 */
export async function waitForBlockedBackendOn(
  databaseUrl: string,
  timeoutMs = 3000,
  minBlocked = 1,
): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await waitForBlockedBackend(
      drizzle(client, { schema }) as unknown as DatabaseClient,
      timeoutMs,
      minBlocked,
    );
  } finally {
    await client.end();
  }
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
 * @param minBlocked - How many backends must be waiting on the transaction's
 *   locks before it commits; raise it when `request` fires several statements.
 * @returns Whatever `request` resolves to.
 */
export async function raceAgainstOpenTransaction<T>(
  databaseUrl: string,
  mutate: (tx: Transaction) => Promise<void>,
  request: () => Promise<T>,
  minBlocked = 1,
): Promise<T> {
  const client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  const db = drizzle(client, { schema }) as unknown as DatabaseClient;
  try {
    return await raceWith(db, mutate, request, minBlocked);
  } finally {
    await client.end();
  }
}

async function raceWith<T>(
  db: DatabaseClient,
  mutate: (tx: Transaction) => Promise<void>,
  request: () => Promise<T>,
  minBlocked: number,
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
    await waitForBlockedBackend(db, 3000, minBlocked);
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
