import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export function uniqueEmail(prefix = 'pw'): string {
  return `${prefix}-${randomBytes(3).toString('hex')}@test.local`;
}

const POSTGRES_CONTAINER = process.env.E2E_POSTGRES_CONTAINER ?? 'squad-admin-panel-postgres-1';
const POSTGRES_USER = process.env.E2E_POSTGRES_USER ?? 'admin';
const POSTGRES_DB = process.env.E2E_POSTGRES_DB ?? 'admin';
const REDIS_CONTAINER = process.env.E2E_REDIS_CONTAINER ?? 'squad-admin-panel-redis-1';
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost';

/**
 * Runs one SQL statement in the stack's Postgres container.
 *
 * The statement is passed as an argument vector, never through a shell, so `$1`, `$$`
 * and backticks reach psql untouched. The container, user and database default to the
 * local stack and can be pointed at an isolated database with `E2E_POSTGRES_*`.
 */
export function runSql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      POSTGRES_CONTAINER,
      'psql',
      '-U',
      POSTGRES_USER,
      '-d',
      POSTGRES_DB,
      '-At',
      '-c',
      sql,
    ],
    { encoding: 'utf-8' },
  ).trim();
}

/** Runs one `redis-cli` command in the stack's Redis container (`E2E_REDIS_CONTAINER`). */
export function redisCmd(args: string[]): string {
  return execFileSync('docker', ['exec', '-i', REDIS_CONTAINER, 'redis-cli', ...args], {
    encoding: 'utf-8',
  }).trim();
}

function mintRawToken(): { token: string; tokenId: string } {
  const raw = randomBytes(24).toString('base64url');
  const token = `s_${randomUUID()}_${raw}`;
  const tokenId = createHash('sha256').update(token).digest('base64url');
  return { token, tokenId };
}

export async function seedOwner(steamId64?: string): Promise<{ uid: string; token: string }> {
  const sid = steamId64 ?? `7656119${Math.floor(9_000_000_000 + Math.random() * 999_999_999)}`;
  const name = `pw-owner-${randomBytes(3).toString('hex')}`;
  const ownerRoleId = runSql("SELECT id FROM roles WHERE name='Owner' LIMIT 1");

  runSql(
    `INSERT INTO players (steam_id64, canonical_name, canonical_name_normalized, role_id) VALUES (${sid}, '${name}', '${name}', '${ownerRoleId}') ON CONFLICT (steam_id64) DO UPDATE SET role_id='${ownerRoleId}'`,
  );
  const playerId = runSql(`SELECT id FROM players WHERE steam_id64=${sid} LIMIT 1`);
  runSql(
    `INSERT INTO player_name_history (player_id, name, name_normalized) VALUES ('${playerId}', '${name}', '${name}') ON CONFLICT DO NOTHING`,
  );

  const { token, tokenId } = mintRawToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  runSql(
    `INSERT INTO sessions (id, player_id, expires_at, last_activity_at) VALUES ('${tokenId}', '${playerId}', '${expiresAt}', now())`,
  );
  // No Redis cache entry: the API authenticates its own cache entries (#30)
  // and loads this session from the row above on first use.

  return { uid: sid, token };
}

export async function teardownOwner(uid: string) {
  const playerId = runSql(`SELECT id FROM players WHERE steam_id64=${uid}`);
  if (!playerId) return;
  const tokenIds = runSql(`SELECT id FROM sessions WHERE player_id='${playerId}'`);
  for (const tid of tokenIds.split('\n').filter(Boolean)) {
    redisCmd(['DEL', `session:${tid}`]);
    runSql(`DELETE FROM sessions WHERE id='${tid}'`);
  }
  runSql(`UPDATE players SET role_id=NULL WHERE steam_id64=${uid}`);
  runSql(
    `DELETE FROM player_name_history WHERE player_id='${playerId}' AND name LIKE 'pw-owner-%'`,
  );
  try {
    runSql(`DELETE FROM players WHERE steam_id64=${uid}`);
  } catch {
    // player may have audit references — leave tombstoned with null role
  }
}

/** Attaches the seeded owner's session cookie to `context` for `PLAYWRIGHT_BASE_URL`. */
export async function loginAndAttachCookie(
  context: BrowserContext,
  seedResult: { uid: string; token: string },
): Promise<string> {
  await context.addCookies([
    {
      name: '__Host-sid',
      value: seedResult.token,
      url: BASE_URL,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  return seedResult.token;
}
