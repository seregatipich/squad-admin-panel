import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  ensureWorkerDatabase,
  redisBaseDatabase,
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
    for (const base of [8, 9, 12, 15]) {
      const slots = [1, 2, 3, 4, 5, 6, 7, 8].map((poolId) => workerRedisDatabase(poolId, base));
      expect(new Set(slots).size, `base ${base}`).toBe(8);
      for (const slot of slots) {
        expect(slot).toBeGreaterThanOrEqual(8);
        expect(slot).toBeLessThanOrEqual(15);
      }
    }
  });

  it('без базы отсчитывает слоты от логической базы 8, как раньше', () => {
    for (const poolId of [1, 2, 3, 4, 7, 8, 9]) {
      expect(workerRedisDatabase(poolId)).toBe(8 + (poolId % 8));
    }
  });

  it('берёт номер логической базы из URL как базу отсчёта слотов', () => {
    // Слоты первого файла — по четыре подряд от базы: 8..11 и 12..15 не пересекаются.
    const slotsOf = (base: number) =>
      [1, 2, 3, 4].map((poolId) => workerRedisDatabase(poolId, base));
    expect(slotsOf(8)).toEqual([9, 10, 11, 12]);
    expect(slotsOf(12)).toEqual([13, 14, 15, 8]);
    expect(workerRedisDatabase(1, 15)).toBe(8);
    expect(workerRedisDatabase(3, 11)).toBe(14);
  });

  it('читает базу из URL и отбрасывает номера вне диапазона 8..15', () => {
    expect(redisBaseDatabase('redis://:secret@127.0.0.1:6379/8')).toBe(8);
    expect(redisBaseDatabase('redis://:secret@127.0.0.1:6379/11')).toBe(11);
    expect(redisBaseDatabase('redis://127.0.0.1:6379/15')).toBe(15);
    // 0 — база локального стенда, 1..7 — тесты воркеров, 16 — за пределами Redis.
    expect(redisBaseDatabase('redis://127.0.0.1:6379/0')).toBe(8);
    expect(redisBaseDatabase('redis://127.0.0.1:6379/7')).toBe(8);
    expect(redisBaseDatabase('redis://127.0.0.1:6379/16')).toBe(8);
    expect(redisBaseDatabase('redis://127.0.0.1:6379')).toBe(8);
    expect(redisBaseDatabase('redis://127.0.0.1:6379/abc')).toBe(8);
    expect(redisBaseDatabase('не url')).toBe(8);
  });

  it('направляет файл в базу, выведенную из URL запуска и слота пула', () => {
    const baseUrl = process.env.TEST_REDIS_BASE_URL;
    if (!baseUrl) throw new Error('TEST_REDIS_BASE_URL не задан рабочим setup-файлом');
    const redisUrl = process.env.TEST_REDIS_URL;
    if (!redisUrl) throw new Error('TEST_REDIS_URL не задан рабочим setup-файлом');
    const poolId = Number(process.env.VITEST_POOL_ID);
    const expected = workerRedisDatabase(poolId, redisBaseDatabase(baseUrl));
    expect(new URL(redisUrl).pathname).toBe(`/${expected}`);
  });
});
