/**
 * The server-detail page polls /api/v1/servers/:id every 3 s and surfaces
 * the freshness as "обновлено Xс назад" + a pulsing dot. Before the
 * LiveIndicator addition the only timestamp was rcon_status.ts (worker-
 * published), which barely moved → users thought the page was stale.
 * This spec pins:
 *   - indicator is rendered,
 *   - counter resets back toward 0 once a new poll lands within the
 *     polling interval.
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';

const TEST_EMAIL = `pw-${randomBytes(3).toString('hex')}@test.local`;
const TEST_PASSWORD = 'correct-horse-battery-staple';

function runSql(sql: string): string {
  return execSync(
    `docker exec -i squad-admin-panel-postgres-1 psql -U admin -d admin -At -c ${JSON.stringify(sql)}`,
    { encoding: 'utf-8' },
  ).trim();
}

async function seedOwner(): Promise<string> {
  const ownerRoleId = runSql("SELECT id FROM roles WHERE name='Owner' LIMIT 1");
  const ownerOrg = runSql(`SELECT org_id FROM roles WHERE id='${ownerRoleId}'`);
  // argon2 PHC strings contain `$` chars that every layer of shell tries to
  // interpret as variable interpolation. Cleanest path: write the hash into
  // the postgres container's /tmp as a file, then have psql read it via a
  // parameterised query.
  const hash = execSync(
    `docker exec squad-admin-panel-api-1 node --input-type=module -e "import('@node-rs/argon2').then(m=>m.hash('${TEST_PASSWORD}',{algorithm:2,memoryCost:65536,timeCost:3,parallelism:1,outputLen:32,saltLength:16})).then(h=>process.stdout.write(h))"`,
    { encoding: 'utf-8' },
  ).trim();
  const uid = runSql('SELECT gen_random_uuid()');
  // Feed the INSERT via stdin so the hash is in a Postgres string literal,
  // not a shell argument. Single-quote-escape per Postgres rules (double up
  // any embedded ' — there are none in a well-formed PHC string).
  const escaped = hash.replace(/'/g, "''");
  const sql = `INSERT INTO users (id, email, password_hash, display_name) VALUES ('${uid}', '${TEST_EMAIL}', '${escaped}', 'Playwright Owner');`;
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

async function teardownOwner(uid: string) {
  runSql(`DELETE FROM user_role_assignments WHERE user_id='${uid}'`);
  runSql(`DELETE FROM organization_members WHERE user_id='${uid}'`);
  runSql(`DELETE FROM users WHERE id='${uid}'`);
}

test.describe('server detail live-refresh indicator', () => {
  test('indicator tick/reset proves the page polls without manual reload', async ({
    page,
    request,
  }) => {
    const uid = await seedOwner();
    try {
      // Auth via API — faster + avoids Monaco/form races.
      const login = await request.post('/api/v1/auth/login', {
        data: { email: TEST_EMAIL, password: TEST_PASSWORD },
        ignoreHTTPSErrors: true,
      });
      expect(login.ok(), await login.text()).toBe(true);
      const setCookie = login.headers()['set-cookie'] ?? '';
      const m = setCookie.match(/(__Host-sid=[^;]+)/);
      expect(m).toBeTruthy();
      const cookieValue = m?.[1]?.replace('__Host-sid=', '');
      await page.context().addCookies([
        {
          name: '__Host-sid',
          value: cookieValue,
          url: page.context()._options.baseURL ?? 'https://squad-panel.lan',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]);

      const anyServerId = runSql('SELECT id FROM servers LIMIT 1');
      if (!anyServerId) {
        test.skip(true, 'no server rows — create one first');
        return;
      }
      await page.goto(`/servers/${anyServerId}`);

      // 1. indicator exists
      const indicator = page.locator('text=/обновлено \\d+с назад/');
      await expect(indicator).toBeVisible({ timeout: 10_000 });

      // 2. it should reset to 0/1 at some point within a polling window
      //    (3 s interval + 2 s grace for slow CI).
      let sawReset = false;
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(500);
        const t = (await indicator.textContent())?.match(/(\d+)с/)?.[1];
        if (t && Number(t) <= 1) {
          sawReset = true;
          break;
        }
      }
      expect(sawReset, 'indicator never reset — polling appears broken').toBe(true);

      // 3. pulsing green dot is present (not red / grey)
      const dot = page.locator('span.bg-green-500, span.bg-green-700').first();
      await expect(dot).toBeVisible();
    } finally {
      await teardownOwner(uid);
    }
  });
});
