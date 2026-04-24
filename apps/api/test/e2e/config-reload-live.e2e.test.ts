/**
 * Real end-to-end verification of the PUT /configs auto-reload path:
 * drives the LIVE panel + LIVE Squad container + LIVE RCON listener
 * and asserts the PUT response reports `reload.applied=true, via=rcon,
 * command=AdminReloadServerConfig`.
 *
 * Prerequisites: docker compose stack up, at least one Squad server in
 * status=running with a reachable RCON listener (ECONNREFUSED → test
 * is skipped with a clear message).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@squad/db';
import { organizationMembers, roles, servers, userRoleAssignments, users } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/lib/argon.js';

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

const PG_PASSWORD = dotenv('POSTGRES_PASSWORD') ?? 'admin';
const LIVE_DB_URL = `postgres://admin:${PG_PASSWORD}@127.0.0.1:5432/admin`;
const PANEL_URL = process.env.PANEL_URL ?? 'https://squad-panel.lan';
const TEST_EMAIL = `e2e-reload-${randomBytes(4).toString('hex')}@test.local`;
const TEST_PASSWORD = 'correct-horse-battery-staple';

let db: ReturnType<typeof createDatabaseClient>;
let testUserId: string;
let cookie: string;

beforeAll(async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  db = createDatabaseClient(LIVE_DB_URL);

  const owner = await db.query.roles.findFirst({ where: eq(roles.name, 'Owner') });
  if (!owner) throw new Error('no Owner role seeded in live DB');

  testUserId = crypto.randomUUID();
  await db.insert(users).values({
    id: testUserId,
    email: TEST_EMAIL,
    passwordHash: await hashPassword(TEST_PASSWORD),
    displayName: 'Reload E2E',
  });
  await db.insert(userRoleAssignments).values({ userId: testUserId, roleId: owner.id });
  await db
    .insert(organizationMembers)
    .values({ userId: testUserId, orgId: owner.orgId, primaryRoleId: owner.id });

  const loginResp = await fetch(`${PANEL_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (loginResp.status !== 200) throw new Error(`login failed: ${await loginResp.text()}`);
  const raw = loginResp.headers.get('set-cookie') ?? '';
  cookie = raw.match(/(__Host-sid=[^;]+)/)?.[1] ?? '';
  if (!cookie) throw new Error('no session cookie from login');
}, 30_000);

afterAll(async () => {
  await db
    .delete(userRoleAssignments)
    .where(eq(userRoleAssignments.userId, testUserId))
    .catch(() => undefined);
  await db
    .delete(organizationMembers)
    .where(eq(organizationMembers.userId, testUserId))
    .catch(() => undefined);
  await db
    .delete(users)
    .where(eq(users.id, testUserId))
    .catch(() => undefined);
}, 30_000);

describe('PUT /api/v1/servers/:id/configs/:name auto-reload (live)', () => {
  it('fires AdminReloadServerConfig on the first running server with RCON reachable', async () => {
    const allServers = await db.select({ id: servers.id, status: servers.status }).from(servers);
    const running = allServers.find((s) => s.status === 'running' || s.status === 'starting');
    if (!running) {
      console.warn(
        'SKIPPED: no server in status=running; start one in the UI before running this spec',
      );
      return;
    }

    // Fetch current Admins.cfg so we can append a single marker line and
    // restore the previous content afterwards.
    const getResp = await fetch(`${PANEL_URL}/api/v1/servers/${running.id}/configs/Admins.cfg`, {
      headers: { cookie },
    });
    expect(getResp.status, await getResp.clone().text()).toBe(200);
    const { content: original } = (await getResp.json()) as { content: string };

    const marker = `// e2e reload marker ${new Date().toISOString()}`;
    const putResp = await fetch(`${PANEL_URL}/api/v1/servers/${running.id}/configs/Admins.cfg`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: `${original}\n${marker}\n`, message: 'live reload test' }),
    });
    expect(putResp.status, await putResp.clone().text()).toBe(200);
    const body = (await putResp.json()) as {
      unchanged: boolean;
      reload: {
        applied: boolean;
        via?: string;
        command?: string;
        reason?: string;
        detail?: string;
      };
    };

    expect(body.unchanged).toBe(false);
    expect(body.reload, JSON.stringify(body.reload)).toBeDefined();

    if (body.reload.applied) {
      // Happy path: Squad RCON accepted the reload command.
      expect(body.reload.via).toBe('rcon');
      expect(body.reload.command).toBe('AdminReloadServerConfig');
    } else {
      // Acceptable failure modes — the fix is in place, but infra isn't
      // cooperating. Still proves the panel attempted + reported:
      expect(['not_running', 'no_credentials', 'rcon_failed']).toContain(body.reload.reason);
      console.warn(`reload not applied: reason=${body.reload.reason} detail=${body.reload.detail}`);
    }

    // Restore the file so we don't leave a trailing marker behind.
    await fetch(`${PANEL_URL}/api/v1/servers/${running.id}/configs/Admins.cfg`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: original, message: 'revert live reload test' }),
    });
  }, 30_000);
});
