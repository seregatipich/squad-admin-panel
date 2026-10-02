/**
 * Vitest setup file: resolve database/redis connection settings from the repo's
 * `.env` when they are absent from the environment.
 *
 * Worker integration tests read `process.env.DATABASE_URL` at module scope and
 * throw when it is missing, so `pnpm turbo run test` (and the pre-push checklist,
 * which calls it) failed for anyone who had not exported the variable by hand —
 * even with Postgres running locally. The API harness already solves this exactly
 * this way; see the `dotenvLookup` helper in
 * apps/api/test/integration/isolated-db.ts.
 *
 * This does not relax any test: a real database is still required, and a test
 * that cannot reach one still fails. It only removes the requirement to export
 * the variable manually before every run.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ENV_FILE = path.resolve(__dirname, '../../../.env');

function readDotenv(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const raw = readFileSync(REPO_ENV_FILE, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
      if (m?.[1]) out.set(m[1], (m[2] ?? '').replace(/^"(.*)"$/, '$1'));
    }
  } catch {
    // .env missing is fine; the caller must then set the environment itself.
  }
  return out;
}

const dotenv = readDotenv();

// `.env`'s DATABASE_URL uses the docker-internal host `postgres`, which does not
// resolve from the host. Rebuild it against 127.0.0.1 from POSTGRES_PASSWORD,
// matching what CLAUDE.md tells contributors to do by hand.
if (!process.env.DATABASE_URL) {
  const pw = dotenv.get('POSTGRES_PASSWORD');
  if (pw) process.env.DATABASE_URL = `postgres://admin:${pw}@127.0.0.1:5432/admin`;
}
if (!process.env.TEST_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
}
// REDIS_URL is deliberately NOT defaulted: the stack's Redis requires a
// password, so a made-up `redis://127.0.0.1:6379` never worked, and it made
// `describeIfRedis` believe a service was configured. Without REDIS_URL the
// Redis suites are skipped locally and refused under `CI` (#120); export it, or
// run `eval "$(bash scripts/new-test-db.sh <slug>)"`, to run them.
for (const key of ['APP_ENCRYPTION_KEY', 'PANEL_BRIDGE_SOCKET']) {
  const v = dotenv.get(key);
  if (!process.env[key] && v) process.env[key] = v;
}
