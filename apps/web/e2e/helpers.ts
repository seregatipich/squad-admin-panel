import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

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

export async function seedOwner(email: string): Promise<string> {
  const ownerRoleId = runSql("SELECT id FROM roles WHERE name='Owner' LIMIT 1");
  const ownerOrg = runSql(`SELECT org_id FROM roles WHERE id='${ownerRoleId}'`);
  const hash = execSync(
    `docker exec squad-admin-panel-api-1 node --input-type=module -e "import('@node-rs/argon2').then(m=>m.hash('${TEST_PASSWORD}',{algorithm:2,memoryCost:65536,timeCost:3,parallelism:1,outputLen:32,saltLength:16})).then(h=>process.stdout.write(h))"`,
    { encoding: 'utf-8' },
  ).trim();
  const uid = runSql('SELECT gen_random_uuid()');
  const escaped = hash.replace(/'/g, "''");
  const sql = `INSERT INTO users (id, email, password_hash, display_name) VALUES ('${uid}', '${email}', '${escaped}', 'Playwright Owner');`;
  execSync(
    `docker exec -i squad-admin-panel-postgres-1 psql -U admin -d admin -v ON_ERROR_STOP=1`,
    {
      input: sql,
      encoding: 'utf-8',
    },
  );
  runSql(`INSERT INTO user_role_assignments (user_id,role_id) VALUES ('${uid}','${ownerRoleId}')`);
  runSql(
    `INSERT INTO organization_members (user_id,org_id,primary_role_id) VALUES ('${uid}','${ownerOrg}','${ownerRoleId}')`,
  );
  return uid;
}

export async function teardownOwner(uid: string) {
  runSql(`DELETE FROM user_role_assignments WHERE user_id='${uid}'`);
  runSql(`DELETE FROM organization_members WHERE user_id='${uid}'`);
  // audit_log.actor_user_id has a no-cascade FK and audit_log is append-only,
  // so we can't always DELETE the user. If the user has audit rows (because
  // the test logged in successfully), tombstone the user instead — strip
  // creds and rename so the row is harmless and the email is reusable.
  try {
    execSync(
      `docker exec -i squad-admin-panel-postgres-1 psql -U admin -d admin -At -v ON_ERROR_STOP=1 -c "DELETE FROM users WHERE id='${uid}'"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    runSql(
      `UPDATE users SET email='deleted-${uid}@test.local', display_name='deleted', password_hash='', totp_secret_encrypted=NULL, totp_backup_codes_hash=NULL WHERE id='${uid}'`,
    );
  }
}

export async function loginAndAttachCookie(
  page: Page,
  context: BrowserContext,
  request: APIRequestContext,
  email: string,
): Promise<string> {
  const login = await request.post('/api/v1/auth/login', {
    data: { email, password: TEST_PASSWORD },
    ignoreHTTPSErrors: true,
  });
  if (!login.ok()) throw new Error(`login failed: ${login.status()} ${await login.text()}`);
  const setCookie = login.headers()['set-cookie'] ?? '';
  const m = setCookie.match(/(__Host-sid=[^;]+)/);
  const cookieValue = m?.[1]?.replace('__Host-sid=', '');
  if (!cookieValue) throw new Error('no __Host-sid set-cookie returned by /auth/login');
  const baseURL = (context as unknown as { _options?: { baseURL?: string } })._options?.baseURL;
  await context.addCookies([
    {
      name: '__Host-sid',
      value: cookieValue,
      url: baseURL ?? page.url() ?? 'https://squad-panel.lan',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
  return cookieValue;
}
