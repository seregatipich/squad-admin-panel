import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CreatedSchema, createIsolatedSchema } from './integration/isolated-db.js';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/14';

type SqlClient = ReturnType<typeof postgres>;

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('pnpm', ['--silent', 'revoke:sessions-for-sso-cutover', '--', ...args], {
    cwd: REPOSITORY_ROOT,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
}

describe('one-shot SSO cutover session revocation', () => {
  let database: CreatedSchema;
  let sql: SqlClient;
  let redis: Redis;
  let databaseUrl: string;
  const playerId = randomUUID();
  const sessionIds = [`cutover-${randomUUID()}`, `cutover-${randomUUID()}`];
  const unrelatedKey = `cutover-unrelated-${randomUUID()}`;

  beforeAll(async () => {
    database = await createIsolatedSchema();
    databaseUrl = database.url;
    sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    redis = new Redis(TEST_REDIS_URL);
    await sql`
      INSERT INTO players (id, canonical_name, canonical_name_normalized)
      VALUES (${playerId}, 'Cutover player', 'cutover player')
    `;
  });

  afterAll(async () => {
    await redis?.del(
      unrelatedKey,
      ...sessionIds.flatMap((id) => [`session:${id}`, `session-touch:${id}`]),
    );
    await redis?.quit();
    await sql?.end();
    await database?.drop();
  });

  it('refuses every invocation without the exact confirmation flag', () => {
    for (const args of [[], ['--confirm-all-sessions=true'], ['--confirm-all-sessions', 'extra']]) {
      const result = runCli(args, { ...process.env, DATABASE_URL: '', REDIS_URL: '' });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('--confirm-all-sessions');
    }
  });

  it('deletes database rows and both exact Redis key families without scanning', async () => {
    for (const id of sessionIds) {
      await sql`
        INSERT INTO sessions (id, player_id, expires_at, last_activity_at, scope)
        VALUES (${id}, ${playerId}, now() + interval '1 hour', now(), 'panel')
      `;
      await redis.set(`session:${id}`, 'cached');
      await redis.set(`session-touch:${id}`, '1');
    }
    await redis.set(unrelatedKey, 'keep');

    const result = runCli(['--confirm-all-sessions'], {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: TEST_REDIS_URL,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('Отозвано сессий панели: 2\n');
    expect(result.stdout).not.toContain(playerId);
    expect(sessionIds.every((id) => !result.stdout.includes(id))).toBe(true);
    expect(await sql`SELECT id FROM sessions WHERE player_id = ${playerId}`).toEqual([]);
    expect(
      await redis.mget(...sessionIds.flatMap((id) => [`session:${id}`, `session-touch:${id}`])),
    ).toEqual([null, null, null, null]);
    expect(await redis.get(unrelatedKey)).toBe('keep');

    const repeated = runCli(['--confirm-all-sessions'], {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: TEST_REDIS_URL,
    });
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toBe('Отозвано сессий панели: 0\n');
  });

  it('exits non-zero on Redis failure and leaves database sessions retryable', async () => {
    const sessionId = `cutover-${randomUUID()}`;
    await sql`
      INSERT INTO sessions (id, player_id, expires_at, last_activity_at, scope)
      VALUES (${sessionId}, ${playerId}, now() + interval '1 hour', now(), 'panel')
    `;

    const result = runCli(['--confirm-all-sessions'], {
      ...process.env,
      DATABASE_URL: databaseUrl,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Не удалось отозвать сессии панели');
    expect(result.stderr).not.toContain(databaseUrl);
    expect(await sql`SELECT id FROM sessions WHERE id = ${sessionId}`).toHaveLength(1);
    await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
  });

  it('exits non-zero on database failure without disclosing credentials', () => {
    const credential = `cutover-secret-${randomUUID()}`;
    const result = runCli(['--confirm-all-sessions'], {
      ...process.env,
      DATABASE_URL: `postgresql://admin:${credential}@127.0.0.1:1/admin`,
      REDIS_URL: TEST_REDIS_URL,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Не удалось отозвать сессии панели');
    expect(result.stderr).not.toContain(credential);
  });
});
