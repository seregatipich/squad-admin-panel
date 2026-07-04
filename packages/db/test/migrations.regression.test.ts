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

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let pgsql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
  if (!DATABASE_URL) return;
  pgsql = postgres(DATABASE_URL);
  db = drizzle(pgsql, { schema });
});

afterAll(async () => {
  if (pgsql) await pgsql.end({ timeout: 5 });
});

describeIfDb('migration regressions', () => {
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

  it('servers_slug_key unique index dropped (0013 replaced with partial index)', async () => {
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'servers' AND indexname = 'servers_slug_key';
    `);
    expect((rows as unknown[]).length).toBe(0);
  });

  it('servers_status_idx index exists (0010 recreated after org drop)', async () => {
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'servers' AND indexname = 'servers_status_idx';
    `);
    expect((rows as unknown[]).length).toBe(1);
  });

  it('servers has deleted_at column', async () => {
    const rows = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'servers' AND column_name = 'deleted_at';
    `);
    expect((rows as unknown[]).length).toBe(1);
  });

  it('migration 0020 replaces deleted_by_steam_id64 with deleted_by_player_id', async () => {
    const current = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'servers' AND column_name = 'deleted_by_player_id';
    `);
    const legacy = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'servers' AND column_name = 'deleted_by_steam_id64';
    `);
    expect((current as unknown[]).length).toBe(1);
    expect((legacy as unknown[]).length).toBe(0);
  });

  it('migration 0020 gives players a UUID primary key', async () => {
    const rows = await db.execute(sql`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = 'public' AND t.relname = 'players' AND i.indisprimary;
    `);
    expect(rows).toEqual([expect.objectContaining({ column_name: 'id' })]);
  });

  it('servers has deletion_backup_marker_id column', async () => {
    const rows = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'servers' AND column_name = 'deletion_backup_marker_id';
    `);
    expect((rows as unknown[]).length).toBe(1);
  });

  it('servers_slug_active_key is partial unique on deleted_at IS NULL', async () => {
    const rows = (await db.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'servers' AND indexname = 'servers_slug_active_key';
    `)) as unknown as Array<{ indexdef: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE/i);
    expect(rows[0].indexdef).toMatch(/WHERE \(deleted_at IS NULL\)/i);
  });

  it('two servers can share slug if one is deleted', async () => {
    const slug = `regression-soft-delete-${Date.now()}`;
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    try {
      await db.execute(sql`
        INSERT INTO servers (id, display_name, slug)
        VALUES (${firstId}::uuid, 'first', ${slug});
      `);
      await db.execute(sql`
        UPDATE servers SET deleted_at = now() WHERE id = ${firstId}::uuid;
      `);
      await db.execute(sql`
        INSERT INTO servers (id, display_name, slug)
        VALUES (${secondId}::uuid, 'second', ${slug});
      `);
      const rows = (await db.execute(sql`
        SELECT id FROM servers WHERE slug = ${slug};
      `)) as unknown as Array<{ id: string }>;
      expect(rows.length).toBe(2);
    } finally {
      await db.execute(sql`DELETE FROM servers WHERE id IN (${firstId}::uuid, ${secondId}::uuid);`);
    }
  });
});
