import type { DatabaseClient } from '@squad/db';
import * as schema from '@squad/db/schema';
import { players, roles, sessions } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSession,
  invalidateSessionCache,
  resolveSession,
  revokeAllForPlayer,
} from '../src/lib/sessions.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import { createIsolatedSchema, runMigrations } from './integration/harness.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

let schemaInfo: Awaited<ReturnType<typeof createIsolatedSchema>>;
let sql: ReturnType<typeof postgres>;
let db: DatabaseClient;
let redis: Redis;
let roleId: string;

beforeAll(async () => {
  schemaInfo = await createIsolatedSchema();
  await runMigrations(schemaInfo.url);
  sql = postgres(schemaInfo.url, { max: 4, onnotice: () => undefined });
  db = drizzle(sql, { schema }) as unknown as DatabaseClient;
  redis = new Redis(TEST_REDIS_URL);
  const rows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) throw new Error('Owner role missing — migrations not applied?');
  roleId = id;
});

afterAll(async () => {
  await redis.quit();
  await sql.end({ timeout: 5 });
  await schemaInfo.drop();
});

async function seedPlayer(suffix: number): Promise<string> {
  const steamId64 = testSteamId(suffix);
  const [row] = await db
    .insert(players)
    .values({
      steamId64,
      canonicalName: `P${steamId64}`,
      canonicalNameNormalized: `p${steamId64}`,
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error('player insert returned nothing');
  return row.id;
}

async function sessionRowExists(id: string): Promise<boolean> {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id));
  return rows.length === 1;
}

describe('session Redis cache vs. the sessions table', () => {
  it('keeps a session whose cached expiresAt is stale but whose DB row was extended (#52)', async () => {
    const playerId = await seedPlayer(52001);
    const { token, session } = await createSession(db, redis, {
      playerId,
      ip: null,
      userAgent: 'test-ua',
      ttlMs: SIX_HOURS_MS,
    });
    // The state a touch near expiry leaves behind: the DB row is extended while
    // the cache entry written before the touch still carries the old deadline.
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + SIX_HOURS_MS) })
      .where(eq(sessions.id, session.id));
    const cacheKey = `session:${session.id}`;
    const cached = JSON.parse((await redis.get(cacheKey)) ?? '{}') as Record<string, unknown>;
    await redis.set(
      cacheKey,
      JSON.stringify({ ...cached, expiresAt: new Date(Date.now() - 1000).toISOString() }),
      'EX',
      600,
    );

    const resolved = await resolveSession(db, redis, token);

    expect(resolved?.id).toBe(session.id);
    expect(resolved?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await sessionRowExists(session.id)).toBe(true);
  });

  it('still revokes a session that is expired in both the cache and the DB', async () => {
    const playerId = await seedPlayer(52002);
    const { token, session } = await createSession(db, redis, {
      playerId,
      ip: null,
      userAgent: 'test-ua',
      ttlMs: SIX_HOURS_MS,
    });
    const past = new Date(Date.now() - 1000);
    await db.update(sessions).set({ expiresAt: past }).where(eq(sessions.id, session.id));
    const cacheKey = `session:${session.id}`;
    const cached = JSON.parse((await redis.get(cacheKey)) ?? '{}') as Record<string, unknown>;
    await redis.set(cacheKey, JSON.stringify({ ...cached, expiresAt: past.toISOString() }));

    expect(await resolveSession(db, redis, token)).toBeNull();
    expect(await sessionRowExists(session.id)).toBe(false);
    expect(await redis.get(cacheKey)).toBeNull();
  });

  it('invalidateSessionCache drops the cached entry so the next resolve reads the DB', async () => {
    const playerId = await seedPlayer(52003);
    const { session } = await createSession(db, redis, {
      playerId,
      ip: null,
      userAgent: 'test-ua',
      ttlMs: SIX_HOURS_MS,
    });
    expect(await redis.get(`session:${session.id}`)).not.toBeNull();
    await invalidateSessionCache(redis, session.id);
    expect(await redis.get(`session:${session.id}`)).toBeNull();
  });

  it('revokeAllForPlayer also evicts a session created while the revoke is running (#53)', async () => {
    const playerId = await seedPlayer(53001);
    const first = await createSession(db, redis, {
      playerId,
      ip: null,
      userAgent: 'test-ua',
      ttlMs: SIX_HOURS_MS,
    });
    // A concurrent login lands right before the revoke's DELETE statement
    // executes: awaiting the DELETE builder first inserts the racing session.
    let raced: Awaited<ReturnType<typeof createSession>> | null = null;
    const loginBeforeExecute = <T extends object>(builder: T): T =>
      new Proxy(builder, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          if (prop === 'then') {
            return (onFulfilled: never, onRejected: never) =>
              createSession(db, redis, {
                playerId,
                ip: null,
                userAgent: 'racing-login',
                ttlMs: SIX_HOURS_MS,
              }).then((session) => {
                raced = session;
                return value.call(target, onFulfilled, onRejected);
              });
          }
          return (...args: unknown[]) => {
            const result = value.apply(target, args);
            return result === target ? loginBeforeExecute(target) : result;
          };
        },
      });
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'delete') return Reflect.get(target, prop, receiver);
        return (table: typeof sessions) => {
          const builder = target.delete(table);
          return new Proxy(builder, {
            get(b, p) {
              const value = Reflect.get(b, p, b);
              if (p !== 'where' || typeof value !== 'function') return value;
              return (...args: unknown[]) => loginBeforeExecute(value.apply(b, args));
            },
          });
        };
      },
    }) as DatabaseClient;

    const revoked: string[] = [];
    await revokeAllForPlayer(racingDb, redis, playerId, {
      publish: (event) => revoked.push(event.data.session_id),
    });

    expect(raced).not.toBeNull();
    const racedSession = (raced as unknown as Awaited<ReturnType<typeof createSession>>).session;
    expect(await sessionRowExists(first.session.id)).toBe(false);
    expect(await sessionRowExists(racedSession.id)).toBe(false);
    expect(await redis.get(`session:${first.session.id}`)).toBeNull();
    expect(await redis.get(`session:${racedSession.id}`)).toBeNull();
    expect(revoked.sort()).toEqual([first.session.id, racedSession.id].sort());
  });
});
