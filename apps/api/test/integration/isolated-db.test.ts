import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: readFileSyncMock };
});

// Module-load-time env-derived config value: must be re-imported fresh per
// case, mirroring `test/config.test.ts`'s `freshLoadConfig()` shape.
describe('isolated-db password resolution', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    readFileSyncMock.mockReset();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  async function freshIsolatedDb() {
    vi.resetModules();
    return import('./isolated-db.js');
  }

  it('resolves the password from POSTGRES_PASSWORD when set', async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.POSTGRES_PASSWORD = 'from-env-var';
    readFileSyncMock.mockImplementation(() => {
      throw new Error('should not read .env when POSTGRES_PASSWORD is set');
    });

    const { testDbUrl } = await freshIsolatedDb();

    expect(testDbUrl).toBe('postgres://admin:from-env-var@127.0.0.1:5432/admin');
  });

  it('extracts the password from DATABASE_URL when POSTGRES_PASSWORD is unset', async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.DATABASE_URL = 'postgres://admin:from-database-url@postgres:5432/admin';
    readFileSyncMock.mockImplementation(() => {
      throw new Error('should not read .env when DATABASE_URL is set');
    });

    const { testDbUrl } = await freshIsolatedDb();

    expect(testDbUrl).toBe('postgres://admin:from-database-url@127.0.0.1:5432/admin');
  });

  it('falls back to the repo .env file when no env var is set', async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    readFileSyncMock.mockImplementation(() => 'POSTGRES_PASSWORD=from-dotenv-file\n');

    const { testDbUrl } = await freshIsolatedDb();

    expect(testDbUrl).toBe('postgres://admin:from-dotenv-file@127.0.0.1:5432/admin');
    expect(readFileSyncMock).toHaveBeenCalled();
  });

  it('throws instead of silently defaulting to the "admin" password when nothing resolves and TEST_DATABASE_URL is unset', async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });

    await expect(freshIsolatedDb()).rejects.toThrow(/Postgres password/i);
  });

  it('does not evaluate the password fallback when TEST_DATABASE_URL is already set', async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.TEST_DATABASE_URL = 'postgres://someone:something@127.0.0.1:5432/preset';
    readFileSyncMock.mockImplementation(() => {
      throw new Error('should never be called when TEST_DATABASE_URL is set');
    });

    const { testDbUrl } = await freshIsolatedDb();

    expect(testDbUrl).toBe('postgres://someone:something@127.0.0.1:5432/preset');
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });
});
