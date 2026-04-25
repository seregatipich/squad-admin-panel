/**
 * Proves the bridge UMask fix: after a real PUT /configs through the
 * LIVE panel, the on-disk file must be mode 0644 (and its parent
 * ServerConfig/ 0755). Reads the mode via `alpine stat` in a one-shot
 * root-container because the current user cannot stat root-owned files
 * in /var/lib/squad-panel.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@squad/db';
import {
  organizationMembers,
  playerRoleAssignments,
  players,
  roles,
  servers,
  sessions,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintSessionToken } from '../../src/lib/sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function dotenv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const raw = readFileSync(path.resolve(__dirname, '../../../../.env'), 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
      if (m?.[1] === key) return m[2]?.replace(/^"(.*)"$/, '$1');
    }
  } catch {
    // ignore
  }
  return undefined;
}

function statMode(absPath: string): string {
  const out = execSync(
    `docker run --rm -v /var/lib/squad-panel:/data alpine stat -c '%a' /data${absPath.replace('/var/lib/squad-panel', '')}`,
    { encoding: 'utf-8' },
  );
  return out.trim();
}

const PG_PASSWORD = dotenv('POSTGRES_PASSWORD') ?? 'admin';
const LIVE_DB_URL = `postgres://admin:${PG_PASSWORD}@127.0.0.1:5432/admin`;
const PANEL_URL = process.env.PANEL_URL ?? 'https://squad-panel.lan';
const TEST_STEAM_ID = 76561198999999002n;

let db: ReturnType<typeof createDatabaseClient>;
let sessionTokenId: string;
let cookie: string;

beforeAll(async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  db = createDatabaseClient(LIVE_DB_URL);
  const owner = await db.query.roles.findFirst({ where: eq(roles.name, 'Owner') });
  if (!owner) throw new Error('no Owner role seeded in live DB');

  await db
    .insert(players)
    .values({
      steamId64: TEST_STEAM_ID,
      canonicalName: 'E2E Test Player',
      canonicalNameNormalized: 'e2e test player',
    })
    .onConflictDoNothing();
  await db
    .insert(playerRoleAssignments)
    .values({ steamId64: TEST_STEAM_ID, roleId: owner.id })
    .onConflictDoNothing();
  await db
    .insert(organizationMembers)
    .values({ steamId64: TEST_STEAM_ID, orgId: owner.orgId, primaryRoleId: owner.id })
    .onConflictDoNothing();

  const { token, tokenId } = mintSessionToken();
  sessionTokenId = tokenId;
  await db.insert(sessions).values({
    id: tokenId,
    steamId64: TEST_STEAM_ID,
    expiresAt: new Date(Date.now() + 3_600_000),
    lastActivityAt: new Date(),
    ip: null,
    userAgent: null,
  });
  cookie = `__Host-sid=${token}`;
}, 30_000);

afterAll(async () => {
  await db
    .delete(sessions)
    .where(eq(sessions.id, sessionTokenId))
    .catch(() => undefined);
  await db
    .delete(playerRoleAssignments)
    .where(eq(playerRoleAssignments.steamId64, TEST_STEAM_ID))
    .catch(() => undefined);
  await db
    .delete(organizationMembers)
    .where(eq(organizationMembers.steamId64, TEST_STEAM_ID))
    .catch(() => undefined);
  await db
    .delete(players)
    .where(eq(players.steamId64, TEST_STEAM_ID))
    .catch(() => undefined);
}, 30_000);

describe('PUT /configs writes files readable by Squad (uid 1001)', () => {
  it('produces mode 0644 on the file and 0755 on ServerConfig/', async () => {
    const anyServer = await db.select({ id: servers.id }).from(servers).limit(1);
    const serverId = anyServer[0]?.id;
    if (!serverId) {
      console.warn('SKIPPED: no server rows in live DB');
      return;
    }

    // Sabotage the mode first so we can tell whether the *new* bridge
    // actually re-applied 0644 on write.
    execSync(
      `docker run --rm -v /var/lib/squad-panel:/data alpine chmod 0600 /data/configs/${serverId}/ServerConfig/Admins.cfg`,
      { stdio: 'ignore' },
    );
    expect(statMode(`/var/lib/squad-panel/configs/${serverId}/ServerConfig/Admins.cfg`)).toBe(
      '600',
    );

    const current = await fetch(`${PANEL_URL}/api/v1/servers/${serverId}/configs/Admins.cfg`, {
      headers: { cookie: cookie },
    });
    const { content: original } = (await current.json()) as { content: string };

    const putResp = await fetch(`${PANEL_URL}/api/v1/servers/${serverId}/configs/Admins.cfg`, {
      method: 'PUT',
      headers: { cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: `${original}\n// perms check ${Date.now()}\n`,
        message: 'perms e2e',
      }),
    });
    expect(putResp.status, await putResp.clone().text()).toBe(200);

    const fileMode = statMode(`/var/lib/squad-panel/configs/${serverId}/ServerConfig/Admins.cfg`);
    const dirMode = statMode(`/var/lib/squad-panel/configs/${serverId}/ServerConfig`);
    expect(fileMode, 'file must be readable by Squad (uid 1001)').toBe('644');
    expect(dirMode, 'directory must be traversable by Squad (uid 1001)').toBe('755');

    // Restore
    await fetch(`${PANEL_URL}/api/v1/servers/${serverId}/configs/Admins.cfg`, {
      method: 'PUT',
      headers: { cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: original, message: 'revert perms e2e' }),
    });
  }, 30_000);
});
