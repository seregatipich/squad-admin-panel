import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export function uniqueEmail(prefix = 'pw'): string {
  return `${prefix}-${randomBytes(3).toString('hex')}@test.local`;
}

export function runSql(sql: string): string {
  return execSync(
    `docker exec -i squad-admin-panel-postgres-1 psql -U admin -d admin -At -c ${JSON.stringify(sql)}`,
    { encoding: 'utf-8' },
  ).trim();
}

export function redisCmd(args: string[]): string {
  const escaped = args.map((a) => JSON.stringify(a)).join(' ');
  return execSync(`docker exec -i squad-admin-panel-redis-1 redis-cli ${escaped}`, {
    encoding: 'utf-8',
  }).trim();
}

function mintRawToken(): { token: string; tokenId: string } {
  const raw = randomBytes(24).toString('base64url');
  const uuidPart = execSync(`node -e "process.stdout.write(require('crypto').randomUUID())"`, {
    encoding: 'utf-8',
  }).trim();
  const token = `s_${uuidPart}_${raw}`;
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

  const sessionJson = JSON.stringify({
    playerId,
    expiresAt,
    lastActivityAt: new Date().toISOString(),
    ip: null,
    userAgent: null,
  });
  redisCmd(['SET', `session:${tokenId}`, sessionJson, 'EX', '86400']);

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

export async function loginAndAttachCookie(
  page: Page,
  context: BrowserContext,
  _unused: unknown,
  seedResult: { uid: string; token: string },
): Promise<string> {
  const baseURL = (context as unknown as { _options?: { baseURL?: string } })._options?.baseURL;
  await context.addCookies([
    {
      name: '__Host-sid',
      value: seedResult.token,
      url: baseURL ?? page.url() ?? 'https://squad-panel.lan',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  return seedResult.token;
}
