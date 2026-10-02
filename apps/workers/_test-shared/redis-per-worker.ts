/**
 * Vitest setup file: gives each Vitest worker slot its own Redis logical
 * database, so test files that run at the same time never share streams,
 * consumer groups, or heartbeat keys.
 *
 * Rewrites `REDIS_URL`, `TEST_REDIS_URL`, and `TEST_REDIS_DB` together because
 * suites read all three (the contract harness joins the last two). Slots map
 * onto databases 1–7: database 0 is the one a local stack's workers use, and
 * 8–15 belong to the API suite, which FLUSHDBs them. Nothing is flushed here —
 * another package's suite may use the same database concurrently, as every
 * contract test shared database 14 before, and suites delete the keys they
 * create. A pool of more than seven slots wraps around and shares.
 *
 * When neither `TEST_REDIS_URL` nor `REDIS_URL` is set there is no Redis to
 * isolate: nothing is set, so `describeIfRedis` skips locally and refuses to
 * skip under `CI` (#120) instead of believing in a made-up default server.
 */
const FIRST_DATABASE = 1;
const DATABASE_COUNT = 7;

const configured = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
if (configured) {
  const slot = Number(process.env.VITEST_POOL_ID ?? '1');
  const database = String(FIRST_DATABASE + ((slot - 1) % DATABASE_COUNT));
  const base = configured.replace(/\/\d*$/, '');

  process.env.TEST_REDIS_DB = database;
  process.env.TEST_REDIS_URL = `${base}/${database}`;
  process.env.REDIS_URL = `${base}/${database}`;
}
