// regression: migration 0009 left orphaned servers.org_id column after dropping organizations
// Fix: migration 0010 explicitly drops org_id and recreates single-column indexes
//
// regression: servers.is_canary column existed on sister branch but migration was never
// carried over to feat/panel-rbac
// Fix: migration 0011 adds IF NOT EXISTS guard for carry-forward
import * as schema from '@squad/db/schema';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let pgsql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  pgsql = postgres(url);
  db = drizzle(pgsql, { schema });
});

afterAll(async () => {
  if (pgsql) await pgsql.end({ timeout: 5 });
});

describe('migration regressions', () => {
  it('servers table has no org_id column (0010 dropped it)', async () => {
    const rows = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'servers' AND column_name = 'org_id';
    `);
    expect((rows as unknown[]).length).toBe(0);
  });

  it('servers table has is_canary column (0011 carry-forward)', async () => {
    const rows = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'servers' AND column_name = 'is_canary';
    `);
    expect((rows as unknown[]).length).toBe(1);
  });

  it('servers_slug_key unique index exists (0010 recreated after org_id drop)', async () => {
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'servers' AND indexname = 'servers_slug_key';
    `);
    expect((rows as unknown[]).length).toBe(1);
  });

  it('servers_status_idx index exists (0010 recreated after org drop)', async () => {
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'servers' AND indexname = 'servers_status_idx';
    `);
    expect((rows as unknown[]).length).toBe(1);
  });
});
