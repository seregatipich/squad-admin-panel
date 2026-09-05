import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

describe('ресурсы изолированного Vitest-файла', () => {
  it('удаляет собственную рабочую базу до перехода к следующему файлу', async () => {
    const isolatedDb = await import('./isolated-db.js');
    const releaseWorkerResources = (
      isolatedDb as typeof isolatedDb & {
        releaseWorkerResources?: () => Promise<void>;
      }
    ).releaseWorkerResources;
    expect(releaseWorkerResources).toBeTypeOf('function');

    const workerUrl = process.env.TEST_DATABASE_URL;
    if (!workerUrl) throw new Error('TEST_DATABASE_URL не задан рабочим setup-файлом');
    const workerName = new URL(workerUrl).pathname.slice(1);
    expect(workerName).toMatch(/^sqworker_[0-9a-f]{8}_/);

    const maintenanceUrl = new URL(isolatedDb.testDbUrl);
    maintenanceUrl.pathname = '/postgres';
    const admin = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      const before = await admin<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${workerName}) AS exists`;
      expect(before[0]?.exists).toBe(true);

      await releaseWorkerResources?.();

      const after = await admin<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${workerName}) AS exists`;
      expect(after[0]?.exists).toBe(false);
    } finally {
      await admin.end();
    }
  });
});
