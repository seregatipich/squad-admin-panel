/**
 * Real end-to-end regression for the DELETE /api/v1/servers/:id bug:
 * drives the LIVE panel at https://squad-panel.lan (Caddy → api
 * container) against the LIVE Postgres. Does not use the in-process
 * harness or any fake — the whole request round-trips through the
 * deployed stack.
 *
 * Prerequisite: docker compose stack running + panel-host-bridge
 * socket up. This test seeds its own test user directly in the
 * admin database, runs the scenario, and cleans up after itself.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@squad/db';
import {
  configVersions,
  organizationMembers,
  organizations,
  playerRoleAssignments,
  players,
  roles,
  servers,
  sessions,
} from '@squad/db/schema';
import { seedSystemRoles } from '@squad/db/seed';
import { and, eq } from 'drizzle-orm';
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

const PASSWORD = dotenv('POSTGRES_PASSWORD') ?? 'admin';
const LIVE_DB_URL = `postgres://admin:${PASSWORD}@127.0.0.1:5432/admin`;
const PANEL_URL = process.env.PANEL_URL ?? 'https://squad-panel.lan';
const TEST_STEAM_ID = 76561198999999003n;

let db: ReturnType<typeof createDatabaseClient>;
let testOrgId: string;
let sessionTokenId: string;
let sessionCookie: string | null = null;
let createdServerId: string | null = null;

const fetchOpts: RequestInit = {};

beforeAll(async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  db = createDatabaseClient(LIVE_DB_URL);

  const owner = await db.query.roles.findFirst({
    where: eq(roles.name, 'Owner'),
  });
  if (!owner) throw new Error('no Owner role seeded in live DB — is setup complete?');
  testOrgId = owner.orgId;

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
    .values({ steamId64: TEST_STEAM_ID, orgId: testOrgId, primaryRoleId: owner.id })
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
  sessionCookie = `__Host-sid=${token}`;
}, 30_000);

afterAll(async () => {
  if (createdServerId) {
    await db
      .delete(servers)
      .where(eq(servers.id, createdServerId))
      .catch(() => undefined);
  }
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
  void organizations;
  void seedSystemRoles;
}, 30_000);

describe('DELETE /api/v1/servers/:id end-to-end against live panel', () => {
  it('logs in, creates a server, writes a config version, then deletes — through the live HTTPS stack', async () => {
    if (!sessionCookie) throw new Error('session cookie not set by beforeAll');

    // 1. Create a server via the live API.
    const slug = `e2e-del-${randomBytes(3).toString('hex')}`;
    const createResp = await fetch(`${PANEL_URL}/api/v1/servers`, {
      ...fetchOpts,
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({
        display_name: 'E2E Delete Target',
        slug,
        game_port: 27990,
        query_port: 28090,
        beacon_port: 28190,
        rcon_port: 28290,
        max_players: 80,
        tickrate: 50,
        multihome: '0.0.0.0',
      }),
    });
    expect(createResp.status, await createResp.clone().text()).toBe(201);
    const createBody = (await createResp.json()) as { id: string };
    createdServerId = createBody.id;
    expect(createdServerId).toMatch(/^[0-9a-f-]{36}$/i);

    // 3. Write config versions through the real editor endpoint. Owner
    //    must have server:config:write after migration 0005 backfilled
    //    role_permissions; the bridge's file_atomic_write will ALSO need
    //    /var/lib/squad-panel/configs/{uuid}/ServerConfig/ to exist (the
    //    install flow normally creates it). If it doesn't — because no
    //    install ran for this test server — the bridge returns ENOENT;
    //    fall back to seeding directly in that case so the DELETE
    //    cascade is still exercised end-to-end.
    const writeResp = await fetch(
      `${PANEL_URL}/api/v1/servers/${createdServerId}/configs/Admins.cfg`,
      {
        ...fetchOpts,
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: sessionCookie },
        body: JSON.stringify({ content: '// e2e marker', message: 'e2e write' }),
      },
    );
    if (writeResp.status !== 200) {
      // Directory missing on host: seed the row directly so we still prove
      // the DELETE cascade fix. Do not let this mask a real permissions
      // regression though — gate the fallback on a 5xx response.
      const body = await writeResp.clone().text();
      expect(writeResp.status, `PUT /configs failed: ${body}`).toBeGreaterThanOrEqual(500);
      const { createHash } = await import('node:crypto');
      await db.insert(configVersions).values({
        serverId: createdServerId,
        filename: 'Admins.cfg',
        content: '// e2e fallback',
        sha256: createHash('sha256').update('// e2e fallback').digest(),
      });
    }

    // Sanity-check the live DB: config_versions row must exist before the delete.
    const before = await db
      .select()
      .from(configVersions)
      .where(eq(configVersions.serverId, createdServerId));
    expect(before.length).toBeGreaterThanOrEqual(1);

    // 4. The original bug — exercise the real DELETE path via HTTPS.
    const delResp = await fetch(`${PANEL_URL}/api/v1/servers/${createdServerId}`, {
      ...fetchOpts,
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    });
    expect(delResp.status, await delResp.clone().text()).toBe(200);
    const delBody = (await delResp.json()) as { ok: boolean };
    expect(delBody.ok).toBe(true);

    // 5. Row must be gone from both tables.
    const srvAfter = await db.select().from(servers).where(eq(servers.id, createdServerId));
    expect(srvAfter).toHaveLength(0);
    const cvAfter = await db
      .select()
      .from(configVersions)
      .where(eq(configVersions.serverId, createdServerId));
    expect(cvAfter).toHaveLength(0);

    createdServerId = null; // tell afterAll the cleanup already happened
    void and;
  }, 60_000);
});
