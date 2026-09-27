import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  ensureWorkerDatabase,
  releaseWorkerResources,
  testDbUrl,
  workerDatabaseName,
  workerRedisDatabase,
} from './isolated-db.js';

// Этот файл нарочно не упоминает переменные окружения рабочей базы, поэтому
// worker-setup.ts откладывает её клонирование: ниже проверяется ленивый путь.

async function databaseExists(name: string): Promise<boolean> {
  const admin = postgres(testDbUrl, { max: 1, onnotice: () => undefined });
  try {
    const [row] = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${name}) AS exists`;
    return row?.exists ?? false;
  } finally {
    await admin.end();
  }
}

function currentWorkerDatabase(): string {
  const name = workerDatabaseName();
  if (!name) throw new Error('рабочий setup-файл не назначил рабочую базу');
  return name;
}

describe('ресурсы изолированного Vitest-файла', () => {
  it('не клонирует рабочую базу, пока файл к ней не обратился', async () => {
    const name = currentWorkerDatabase();
    expect(name).toMatch(/^sqworker_[0-9a-f]{8}_/);

    expect(await databaseExists(name)).toBe(false);
  });

  it('клонирует мигрированную рабочую базу по первому запросу и переиспользует её', async () => {
    const name = currentWorkerDatabase();

    const [first, second] = await Promise.all([ensureWorkerDatabase(), ensureWorkerDatabase()]);

    expect(second).toBe(first);
    expect(new URL(first).pathname).toBe(`/${name}`);
    expect(await databaseExists(name)).toBe(true);
    const sql = postgres(first, { max: 1, onnotice: () => undefined });
    try {
      const [row] = await sql<{ migrated: boolean }[]>`
        SELECT to_regclass('players') IS NOT NULL AS migrated`;
      expect(row?.migrated).toBe(true);
    } finally {
      await sql.end();
    }
    expect(await ensureWorkerDatabase()).toBe(first);
  });

  it('удаляет собственную рабочую базу до перехода к следующему файлу', async () => {
    const name = currentWorkerDatabase();
    await ensureWorkerDatabase();
    expect(await databaseExists(name)).toBe(true);

    await releaseWorkerResources();

    expect(await databaseExists(name)).toBe(false);
    expect(workerDatabaseName()).toBeNull();
    await expect(releaseWorkerResources()).resolves.toBeUndefined();
  });

  it('выделяет одновременно работающим файлам разные логические базы Redis', () => {
    const slots = [1, 2, 3, 4, 5, 6, 7, 8].map(workerRedisDatabase);
    expect(new Set(slots).size).toBe(8);
    for (const slot of slots) {
      expect(slot).toBeGreaterThanOrEqual(8);
      expect(slot).toBeLessThanOrEqual(15);
    }

    const redisUrl = process.env.TEST_REDIS_URL;
    if (!redisUrl) throw new Error('TEST_REDIS_URL не задан рабочим setup-файлом');
    const poolId = Number(process.env.VITEST_POOL_ID);
    expect(new URL(redisUrl).pathname).toBe(`/${workerRedisDatabase(poolId)}`);
  });
});
