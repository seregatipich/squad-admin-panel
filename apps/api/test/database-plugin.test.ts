import { sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import databasePlugin from '../src/plugins/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('database plugin', () => {
  it('closes its Postgres pool when the app closes (#71)', async () => {
    const app = Fastify({ logger: false });
    await app.register(databasePlugin, {
      config: { DATABASE_URL: databaseUrl } as AppConfig,
    });
    await app.ready();
    await app.db.execute(sql`SELECT 1`);
    const db = app.db;

    await app.close();

    await expect(db.execute(sql`SELECT 1`)).rejects.toMatchObject({
      cause: { code: 'CONNECTION_ENDED' },
    });
  });
});
