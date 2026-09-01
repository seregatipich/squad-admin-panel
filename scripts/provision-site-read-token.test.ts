import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createIsolatedSchema } from '../apps/api/test/integration/isolated-db.ts';
import { parseSiteReadToken, provisionSiteReadToken } from './provision-site-read-token.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(process.argv[1] ?? process.cwd()), '..');
const SCRIPT = path.join(REPOSITORY_ROOT, 'scripts/provision-site-read-token.mjs');
const requireFromApi = createRequire(path.join(REPOSITORY_ROOT, 'apps/api/package.json'));
const postgres = requireFromApi('postgres');

const FIRST_TOKEN = 'sqp_11111111-1111-4111-8111-111111111111_abcdefghijklmnopQRSTUVWX';
const SECOND_TOKEN = 'sqp_22222222-2222-4222-8222-222222222222_0123456789abcdefghijklmn';
const FIRST_HASH = 'eW9rShdBLcktxIv091SBzNoQIzMpe7_HhIGYVdyT8IY';
const SECOND_HASH = 'N93hyR0-4CAv-HusyRaZOn08P8sujuxxuboIMExb6ng';

const databases: Array<{ drop: () => Promise<void> }> = [];

async function databaseWithOwners(count = 1) {
  const database = await createIsolatedSchema();
  databases.push(database);
  const sql = postgres(database.url, { max: 1, onnotice: () => undefined });
  const [ownerRole] = await sql`SELECT id FROM roles WHERE name = 'Owner'`;
  assert.ok(ownerRole?.id, 'миграции должны создать системную роль Owner');

  for (let index = 0; index < count; index += 1) {
    await sql`
      INSERT INTO players (
        steam_id64,
        canonical_name,
        canonical_name_normalized,
        role_id
      ) VALUES (
        ${BigInt(`7656119800000000${index}`)},
        ${`Owner ${index + 1}`},
        ${`owner ${index + 1}`},
        ${ownerRole.id}
      )
    `;
  }

  return sql;
}

afterEach(async () => {
  while (databases.length > 0) await databases.pop()?.drop();
});

describe('provision-site-read-token', () => {
  it('rejects malformed input before touching the database', async () => {
    assert.throws(() => parseSiteReadToken('not-a-token'), /формат/i);
    assert.throws(() => parseSiteReadToken(`${FIRST_TOKEN}\nprocess.exit(0)`), /формат/i);

    let transactionOpened = false;
    const sql = {
      begin() {
        transactionOpened = true;
        throw new Error('database must not be touched');
      },
    };

    await assert.rejects(() => provisionSiteReadToken(sql, 'short'), /формат/i);
    assert.equal(transactionOpened, false);
  });

  it('creates only the two read scopes and never stores plaintext', async () => {
    const sql = await databaseWithOwners();
    try {
      const result = await provisionSiteReadToken(sql, FIRST_TOKEN);
      const [token] = await sql`
        SELECT id, name, token_hash, scopes, revoked_at
        FROM player_api_tokens
      `;
      const audits = await sql`
        SELECT actor_system_label, action_type, after_snapshot, context
        FROM audit_log
        WHERE action_type = 'site.read_token.provision'
      `;

      assert.deepEqual(result, { status: 'changed', revokedTokens: 0 });
      assert.deepEqual(token, {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'bss.games: проверка доступа',
        token_hash: FIRST_HASH,
        scopes: ['user:view', 'role:view'],
        revoked_at: null,
      });
      assert.equal(audits.length, 1);
      assert.equal(audits[0]?.actor_system_label, 'provision-site-read-token');
      assert.equal(audits[0]?.action_type, 'site.read_token.provision');
      assert.deepEqual(audits[0]?.after_snapshot, {
        scopes: ['user:view', 'role:view'],
        status: 'active',
      });
      assert.deepEqual(audits[0]?.context, { revoked_tokens: 0, source: 'operator-command' });

      const persisted = JSON.stringify({ token, audits, result });
      assert.doesNotMatch(persisted, new RegExp(FIRST_TOKEN));
    } finally {
      await sql.end();
    }
  });

  it('runs from stdin inside the existing API image contract', async () => {
    const database = await createIsolatedSchema();
    databases.push(database);
    const sql = postgres(database.url, { max: 1, onnotice: () => undefined });
    try {
      await sql`
        INSERT INTO players (
          steam_id64,
          canonical_name,
          canonical_name_normalized,
          role_id
        )
        SELECT
          76561198000000009,
          'CLI Owner',
          'cli owner',
          id
        FROM roles
        WHERE name = 'Owner'
      `;

      const result = spawnSync(process.execPath, ['--input-type=module'], {
        cwd: path.join(REPOSITORY_ROOT, 'apps/api'),
        env: {
          ...process.env,
          BSS_PROVISION_SITE_READ_TOKEN_RUN: '1',
          DATABASE_URL: database.url,
          SITE_PANEL_READ_TOKEN_B64: Buffer.from(FIRST_TOKEN).toString('base64'),
        },
        input: readFileSync(SCRIPT),
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '{"status":"changed","revokedTokens":0}\n');
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(FIRST_TOKEN));
      const [token] = await sql`SELECT token_hash FROM player_api_tokens`;
      assert.equal(token?.token_hash, FIRST_HASH);
    } finally {
      await sql.end();
    }
  });

  it('does not normalize a trailing newline during stdin transport', () => {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      cwd: path.join(REPOSITORY_ROOT, 'apps/api'),
      env: {
        ...process.env,
        BSS_PROVISION_SITE_READ_TOKEN_RUN: '1',
        DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
        SITE_PANEL_READ_TOKEN_B64: Buffer.from(`${FIRST_TOKEN}\n`).toString('base64'),
      },
      input: readFileSync(SCRIPT),
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Неверный формат ключа чтения сайта/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(FIRST_TOKEN));
  });

  it('is idempotent and rotates only its own previous token', async () => {
    const sql = await databaseWithOwners();
    try {
      assert.deepEqual(await provisionSiteReadToken(sql, FIRST_TOKEN), {
        status: 'changed',
        revokedTokens: 0,
      });
      assert.deepEqual(await provisionSiteReadToken(sql, FIRST_TOKEN), {
        status: 'unchanged',
        revokedTokens: 0,
      });
      assert.deepEqual(await provisionSiteReadToken(sql, SECOND_TOKEN), {
        status: 'changed',
        revokedTokens: 1,
      });

      const tokens = await sql`
        SELECT id, token_hash, scopes, revoked_at IS NULL AS active
        FROM player_api_tokens
        ORDER BY created_at, id
      `;
      const audits = await sql`
        SELECT action_type FROM audit_log
        WHERE action_type = 'site.read_token.provision'
      `;

      assert.deepEqual(Array.from(tokens), [
        {
          id: '11111111-1111-4111-8111-111111111111',
          token_hash: FIRST_HASH,
          scopes: ['user:view', 'role:view'],
          active: false,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          token_hash: SECOND_HASH,
          scopes: ['user:view', 'role:view'],
          active: true,
        },
      ]);
      assert.equal(audits.length, 2, 'неизменившийся повтор не создаёт событие аудита');
    } finally {
      await sql.end();
    }
  });

  it('fails safely when more than one active Owner could own the token', async () => {
    const sql = await databaseWithOwners(2);
    try {
      await assert.rejects(
        () => provisionSiteReadToken(sql, FIRST_TOKEN),
        /ровно один действующий Owner/i,
      );
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM player_api_tokens`;
      assert.equal(count, 0);
    } finally {
      await sql.end();
    }
  });
});
