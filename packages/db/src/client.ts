import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type DatabaseClient = ReturnType<typeof createDatabaseClient>;

export function createDatabaseClient(url: string) {
  const sql = postgres(url, {
    max: 16,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });
  return drizzle(sql, { schema });
}

export { schema };
