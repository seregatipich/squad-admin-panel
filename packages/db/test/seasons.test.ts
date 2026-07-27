// LEAD-7 (#178): leaderboard seasons.
//
// Covers the invariants the table itself must enforce, independently of any
// API validation: at most one `active` season (partial unique index
// `seasons_one_active`), `ends_at > starts_at` (`seasons_bounds_chk`) and the
// `upcoming|active|closed` lifecycle (`seasons_status_chk`).
//
// NOTE on assertions: drizzle-orm 0.45.2 wraps driver errors, and the wrapper
// message contains only "Failed query: ..." — the SQLSTATE and the violated
// constraint name live on `err.cause`. Asserting with `.rejects.toThrow(/name/)`
// therefore silently tests nothing useful, so every constraint assertion here
// walks the cause chain via `pgErrorOf`.
import * as schema from '@squad/db/schema';
import { getTableColumns, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadActiveSeasonTarget } from '../src/leaderboard/season.js';
import { seasons } from '../src/schema/seasons.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

// Every row this file writes carries this prefix so a shared test database
// stays usable for sibling suites.
const NAME_PREFIX = 'lead7-test-';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

let pgsql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

if (DATABASE_URL) {
  pgsql = postgres(DATABASE_URL);
  db = drizzle(pgsql, { schema });
}

interface PgErrorLike {
  code?: string;
  constraint_name?: string;
}

/** Walks the `cause` chain to the driver error that actually carries SQLSTATE. */
function pgErrorOf(err: unknown): PgErrorLike | null {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const candidate = current as PgErrorLike & { cause?: unknown };
    if (typeof candidate.code === 'string') return candidate;
    current = candidate.cause;
  }
  return null;
}

async function captureViolation(run: () => Promise<unknown>): Promise<PgErrorLike> {
  try {
    await run();
  } catch (err) {
    const pg = pgErrorOf(err);
    if (!pg) throw new Error(`expected a driver error with SQLSTATE, got: ${String(err)}`);
    return pg;
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM seasons WHERE name LIKE ${`${NAME_PREFIX}%`}`);
}

afterAll(async () => {
  if (!DATABASE_URL) return;
  await cleanup();
  await pgsql.end({ timeout: 5 });
});

describe('seasons schema surface', () => {
  it('is exported from the package schema barrel', () => {
    expect(schema).toHaveProperty('seasons');
  });

  it('declares the LEAD-7 columns with the documented nullability and defaults', () => {
    const cols = getTableColumns(seasons);
    for (const name of [
      'id',
      'name',
      'startsAt',
      'endsAt',
      'status',
      'finalized',
      'createdAt',
      'updatedAt',
    ]) {
      expect(cols).toHaveProperty(name);
    }
    expect(cols.id.primary).toBe(true);
    expect(cols.id.columnType).toBe('PgUUID');
    expect(cols.name.notNull).toBe(true);
    expect(cols.startsAt.notNull).toBe(true);
    expect(cols.endsAt.notNull).toBe(true);
    expect(cols.status.notNull).toBe(true);
    expect(cols.status.hasDefault).toBe(true);
    expect(cols.finalized.notNull).toBe(true);
    expect(cols.finalized.hasDefault).toBe(true);
  });
});

describeIfDb('seasons table constraints', () => {
  beforeEach(async () => {
    await cleanup();
  });

  it('accepts a well-formed season and defaults finalized to false', async () => {
    const id = uuidv7();
    await db.insert(seasons).values({
      id,
      name: `${NAME_PREFIX}ok`,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2026-03-31T00:00:00.000Z'),
      status: 'upcoming',
    });

    const rows = (await db.execute(
      sql`SELECT status, finalized FROM seasons WHERE id = ${id}::uuid`,
    )) as unknown as Array<{ status: string; finalized: boolean }>;
    expect(rows[0]?.status).toBe('upcoming');
    expect(rows[0]?.finalized).toBe(false);
  });

  it('defaults status to upcoming when the column is omitted', async () => {
    const id = uuidv7();
    await db.execute(sql`
      INSERT INTO seasons (id, name, starts_at, ends_at)
      VALUES (${id}::uuid, ${`${NAME_PREFIX}defaults`},
              '2026-01-01T00:00:00Z'::timestamptz, '2026-02-01T00:00:00Z'::timestamptz)
    `);
    const rows = (await db.execute(
      sql`SELECT status, finalized FROM seasons WHERE id = ${id}::uuid`,
    )) as unknown as Array<{ status: string; finalized: boolean }>;
    expect(rows[0]?.status).toBe('upcoming');
    expect(rows[0]?.finalized).toBe(false);
  });

  it('rejects ends_at == starts_at via seasons_bounds_chk', async () => {
    const err = await captureViolation(() =>
      db.insert(seasons).values({
        id: uuidv7(),
        name: `${NAME_PREFIX}bad-bounds`,
        startsAt: new Date('2026-05-01T00:00:00.000Z'),
        endsAt: new Date('2026-05-01T00:00:00.000Z'),
        status: 'upcoming',
      }),
    );
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.constraint_name).toBe('seasons_bounds_chk');
  });

  it('rejects ends_at < starts_at via seasons_bounds_chk', async () => {
    const err = await captureViolation(() =>
      db.insert(seasons).values({
        id: uuidv7(),
        name: `${NAME_PREFIX}reversed-bounds`,
        startsAt: new Date('2026-05-02T00:00:00.000Z'),
        endsAt: new Date('2026-05-01T00:00:00.000Z'),
        status: 'upcoming',
      }),
    );
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.constraint_name).toBe('seasons_bounds_chk');
  });

  it('rejects a status outside upcoming|active|closed', async () => {
    const err = await captureViolation(() =>
      db.execute(sql`
        INSERT INTO seasons (id, name, starts_at, ends_at, status)
        VALUES (${uuidv7()}::uuid, ${`${NAME_PREFIX}bad-status`},
                '2026-01-01T00:00:00Z'::timestamptz, '2026-02-01T00:00:00Z'::timestamptz,
                'paused')
      `),
    );
    expect(err.code).toBe(CHECK_VIOLATION);
    expect(err.constraint_name).toBe('seasons_status_chk');
  });

  it('allows many upcoming and many closed seasons', async () => {
    for (const [i, status] of (['upcoming', 'upcoming', 'closed', 'closed'] as const).entries()) {
      await db.insert(seasons).values({
        id: uuidv7(),
        name: `${NAME_PREFIX}${status}-${i}`,
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        endsAt: new Date('2026-02-01T00:00:00.000Z'),
        status,
      });
    }
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM seasons WHERE name LIKE ${`${NAME_PREFIX}%`}`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(4);
  });

  it('rejects a second active season via the seasons_one_active partial unique index', async () => {
    await db.insert(seasons).values({
      id: uuidv7(),
      name: `${NAME_PREFIX}active-first`,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2026-02-01T00:00:00.000Z'),
      status: 'active',
    });

    const err = await captureViolation(() =>
      db.insert(seasons).values({
        id: uuidv7(),
        name: `${NAME_PREFIX}active-second`,
        startsAt: new Date('2026-03-01T00:00:00.000Z'),
        endsAt: new Date('2026-04-01T00:00:00.000Z'),
        status: 'active',
      }),
    );
    expect(err.code).toBe(UNIQUE_VIOLATION);
    expect(err.constraint_name).toBe('seasons_one_active');
  });

  it('rejects promoting a second season to active via UPDATE', async () => {
    await db.insert(seasons).values({
      id: uuidv7(),
      name: `${NAME_PREFIX}active-held`,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2026-02-01T00:00:00.000Z'),
      status: 'active',
    });
    const otherId = uuidv7();
    await db.insert(seasons).values({
      id: otherId,
      name: `${NAME_PREFIX}upcoming-promote`,
      startsAt: new Date('2026-03-01T00:00:00.000Z'),
      endsAt: new Date('2026-04-01T00:00:00.000Z'),
      status: 'upcoming',
    });

    const err = await captureViolation(() =>
      db.execute(sql`UPDATE seasons SET status = 'active' WHERE id = ${otherId}::uuid`),
    );
    expect(err.code).toBe(UNIQUE_VIOLATION);
    expect(err.constraint_name).toBe('seasons_one_active');
  });

  it('frees the active slot once the holder is closed', async () => {
    const firstId = uuidv7();
    await db.insert(seasons).values({
      id: firstId,
      name: `${NAME_PREFIX}active-rotate`,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2026-02-01T00:00:00.000Z'),
      status: 'active',
    });
    await db.execute(
      sql`UPDATE seasons SET status = 'closed', finalized = true WHERE id = ${firstId}::uuid`,
    );

    const nextId = uuidv7();
    await db.insert(seasons).values({
      id: nextId,
      name: `${NAME_PREFIX}active-next`,
      startsAt: new Date('2026-03-01T00:00:00.000Z'),
      endsAt: new Date('2026-04-01T00:00:00.000Z'),
      status: 'active',
    });

    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM seasons WHERE status = 'active' AND name LIKE ${`${NAME_PREFIX}%`}`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(1);
  });

  it('enforces a unique season name', async () => {
    await db.insert(seasons).values({
      id: uuidv7(),
      name: `${NAME_PREFIX}dup`,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2026-02-01T00:00:00.000Z'),
      status: 'upcoming',
    });
    const err = await captureViolation(() =>
      db.insert(seasons).values({
        id: uuidv7(),
        name: `${NAME_PREFIX}dup`,
        startsAt: new Date('2026-03-01T00:00:00.000Z'),
        endsAt: new Date('2026-04-01T00:00:00.000Z'),
        status: 'upcoming',
      }),
    );
    expect(err.code).toBe(UNIQUE_VIOLATION);
    expect(err.constraint_name).toBe('seasons_name_key');
  });
});

describeIfDb('loadActiveSeasonTarget', () => {
  beforeEach(async () => {
    await cleanup();
  });

  async function insertSeason(
    name: string,
    status: 'upcoming' | 'active' | 'closed',
    startsAt: string,
    endsAt: string,
    finalized = false,
  ): Promise<string> {
    const id = uuidv7();
    await db.insert(seasons).values({
      id,
      name: `${NAME_PREFIX}${name}`,
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      status,
      finalized,
    });
    return id;
  }

  it('returns null when nothing is active', async () => {
    await insertSeason('idle-upcoming', 'upcoming', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
    await insertSeason('idle-closed', 'closed', '2025-01-01T00:00:00Z', '2025-02-01T00:00:00Z');

    expect(await loadActiveSeasonTarget(pgsql)).toBeNull();
  });

  it('returns the active season as a recompute target with a UTC day window', async () => {
    const id = await insertSeason('live', 'active', '2026-06-10T00:00:00Z', '2026-07-20T00:00:00Z');

    const target = await loadActiveSeasonTarget(pgsql);
    expect(target).toEqual({
      id,
      name: `${NAME_PREFIX}live`,
      periodType: 'season',
      periodStart: '2026-06-10',
      range: { fromDay: '2026-06-10', toDay: '2026-07-20' },
    });
  });

  it('derives the window in UTC, not in the session time zone', async () => {
    // 23:30Z on 2026-06-10 is already 2026-06-11 in a UTC+2 session; the target
    // must still report the UTC day.
    await insertSeason('utc-edge', 'active', '2026-06-10T23:30:00Z', '2026-07-20T23:30:00Z');

    const target = await loadActiveSeasonTarget(pgsql);
    expect(target?.periodStart).toBe('2026-06-10');
    expect(target?.range).toEqual({ fromDay: '2026-06-10', toDay: '2026-07-20' });
  });

  it('skips a finalized season so its materialised rows stay frozen', async () => {
    await insertSeason('frozen', 'active', '2026-06-10T00:00:00Z', '2026-07-20T00:00:00Z', true);

    expect(await loadActiveSeasonTarget(pgsql)).toBeNull();
  });
});
