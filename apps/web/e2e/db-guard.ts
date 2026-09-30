/** Name of the shared development database that e2e tests must never mutate. */
const SHARED_DATABASE = 'admin';

/**
 * Resolves the database the e2e helpers run SQL against.
 *
 * There is deliberately no default: the shared `admin` database is refused so tests
 * cannot mutate it. Provision an isolated one with `scripts/new-test-db.sh` and pass
 * its name via `E2E_POSTGRES_DB`.
 *
 * @param configured value of `E2E_POSTGRES_DB`
 * @returns the isolated database name
 * @throws Error when the value is unset, empty or the shared `admin` database
 */
export function resolveE2eDatabase(configured: string | undefined): string {
  const name = configured?.trim();
  if (!name) {
    throw new Error(
      'E2E_POSTGRES_DB is not set: e2e tests need an isolated database (see scripts/new-test-db.sh)',
    );
  }
  if (name === SHARED_DATABASE) {
    throw new Error(
      `E2E_POSTGRES_DB=${SHARED_DATABASE} is the shared development database; use an isolated one (scripts/new-test-db.sh)`,
    );
  }
  return name;
}
