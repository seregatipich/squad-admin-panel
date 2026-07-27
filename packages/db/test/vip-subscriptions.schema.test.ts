import { getTableColumns, getTableName, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';
import {
  SESSION_SCOPES,
  VIP_SUBSCRIPTION_STATUSES,
  vipSubscriptions,
} from '../src/schema/index.js';
import { sessions } from '../src/schema/sessions.js';

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

describe('vip_subscriptions schema module (VIPSUB-5)', () => {
  it('maps to the vip_subscriptions table', () => {
    expect(getTableName(vipSubscriptions)).toBe('vip_subscriptions');
  });

  it('declares every column named by the VIPSUB-5 specification', () => {
    expect(Object.keys(getTableColumns(vipSubscriptions)).sort()).toEqual([
      'cancelledAt',
      'createdAt',
      'id',
      'nextRenewalAt',
      'playerId',
      'priceBonuses',
      'renewsEveryDays',
      'status',
      'tierId',
    ]);
  });

  it('exposes the three lifecycle statuses', () => {
    expect([...VIP_SUBSCRIPTION_STATUSES]).toEqual(['active', 'cancelled', 'expired']);
  });

  it('exposes the two session scopes', () => {
    expect([...SESSION_SCOPES]).toEqual(['panel', 'self_service']);
  });

  it('adds a scope column to the sessions table', () => {
    expect(Object.keys(getTableColumns(sessions))).toContain('scope');
  });
});

describeIfDb('migration 0104 (vip_subscriptions + sessions.scope)', () => {
  it('creates the vip_subscriptions table with the specified columns', async () => {
    const rows = (await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vip_subscriptions'
      ORDER BY column_name
    `)) as unknown as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>;
    const byName = new Map(rows.map((r) => [r.column_name, r]));

    expect([...byName.keys()]).toEqual([
      'cancelled_at',
      'created_at',
      'id',
      'next_renewal_at',
      'player_id',
      'price_bonuses',
      'renews_every_days',
      'status',
      'tier_id',
    ]);
    expect(byName.get('status')?.is_nullable).toBe('NO');
    expect(byName.get('status')?.column_default).toContain('active');
    expect(byName.get('cancelled_at')?.is_nullable).toBe('YES');
    expect(byName.get('next_renewal_at')?.data_type).toBe('timestamp with time zone');
  });

  it('constrains status, renews_every_days and price_bonuses', async () => {
    const rows = (await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'vip_subscriptions'::regclass AND contype = 'c'
      ORDER BY conname
    `)) as unknown as Array<{ conname: string }>;
    const names = rows.map((r) => r.conname);

    expect(names).toContain('vip_subscriptions_status_chk');
    expect(names).toContain('vip_subscriptions_renews_every_days_chk');
    expect(names).toContain('vip_subscriptions_price_bonuses_chk');
  });

  it('cascades on player delete and restricts on tier delete', async () => {
    const rows = (await db.execute(sql`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE conrelid = 'vip_subscriptions'::regclass AND contype = 'f'
      ORDER BY conname
    `)) as unknown as Array<{ conname: string; confdeltype: string }>;
    const byName = new Map(rows.map((r) => [r.conname, r.confdeltype]));

    expect(byName.get('vip_subscriptions_player_id_fkey')).toBe('c');
    expect(byName.get('vip_subscriptions_tier_id_fkey')).toBe('r');
  });

  it('indexes the renewal scan and enforces one active subscription per player', async () => {
    const rows = (await db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'vip_subscriptions'
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    expect(byName.has('vip_subscriptions_due_idx')).toBe(true);
    expect(byName.has('vip_subscriptions_player_idx')).toBe(true);
    const active = byName.get('vip_subscriptions_one_active_idx');
    expect(active).toContain('UNIQUE');
    expect(active).toContain("status = 'active'");
  });

  it("adds sessions.scope defaulting to 'panel' and constrained to the two scopes", async () => {
    const rows = (await db.execute(sql`
      SELECT column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'scope'
    `)) as unknown as Array<{ column_default: string | null; is_nullable: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_nullable).toBe('NO');
    expect(rows[0]?.column_default).toContain('panel');

    const constraints = (await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'sessions'::regclass AND contype = 'c' AND conname = 'sessions_scope_chk'
    `)) as unknown as Array<{ conname: string }>;
    expect(constraints).toHaveLength(1);
  });
});
