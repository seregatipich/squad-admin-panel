import * as dbSchema from '@squad/db/schema';
import { players, rolePermissions, roles } from '@squad/db/schema';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from '../integration/harness.js';

const OWNER_STEAM = testSteamId(600001);

const PAYLOADS = [
  "'; DROP TABLE players; --",
  "1' OR '1'='1",
  "admin'--",
  "'); DELETE FROM roles WHERE name = 'Owner'; --",
  '../../../etc/passwd',
  '<script>alert(1)</script>',
  'null',
  '0',
  "' UNION SELECT 1,2,3 --",
];

let h: IntegrationHarness;
let sql2: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof dbSchema>>;

let ownerCookie: string;
let createdRoleId: string;

async function login(steamId: bigint): Promise<string> {
  invalidatePermissionCache(steamId);
  const { token } = await createSession(h.db, h.redis, {
    steamId64: steamId,
    ip: null,
    userAgent: 'sql-injection-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function tablesExist(): Promise<boolean> {
  const rows = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('players', 'roles', 'sessions')`,
  );
  const count = Number((rows as unknown as { count: string }[])[0]?.count ?? 0);
  return count >= 3;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  sql2 = postgres(h.url, { max: 2, onnotice: () => undefined });
  db = drizzle(sql2, { schema: dbSchema }) as unknown as ReturnType<
    typeof drizzle<typeof dbSchema>
  >;

  ownerCookie = await login(OWNER_STEAM);

  createdRoleId = uuidv7();
  await db.insert(roles).values({
    id: createdRoleId,
    name: `sqli-test-role-${createdRoleId.slice(0, 8)}`,
    color: 'neutral',
    isSystemRole: false,
  });
}, 60_000);

afterAll(async () => {
  await db
    .delete(rolePermissions)
    .where(eq(rolePermissions.roleId, createdRoleId))
    .catch(() => undefined);
  await db
    .delete(roles)
    .where(eq(roles.id, createdRoleId))
    .catch(() => undefined);
  await sql2.end({ timeout: 5 }).catch(() => undefined);
  await h.cleanup();
}, 60_000);

describe('SQL injection — GET /api/v1/players?q=<payload>', () => {
  for (const payload of PAYLOADS) {
    it(`survives q="${payload}"`, async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/players?q=${encodeURIComponent(payload)}`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(500);
      expect(await tablesExist()).toBe(true);
    });
  }
});

describe('SQL injection — GET /api/v1/players/:steamId', () => {
  for (const payload of PAYLOADS) {
    it(`survives steamId path="${payload}"`, async () => {
      const encoded = encodeURIComponent(payload);
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/players/${encoded}`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(500);
      expect(await tablesExist()).toBe(true);
    });
  }
});

describe('SQL injection — POST /api/v1/roles (name body)', () => {
  for (const payload of PAYLOADS) {
    it(`survives name="${payload}"`, async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/roles',
        headers: { cookie: ownerCookie },
        payload: { name: payload, color: 'neutral', permissions: [] },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(500);
      expect(await tablesExist()).toBe(true);

      if (res.statusCode === 201) {
        const created = res.json<{ id: string }>();
        await db
          .delete(rolePermissions)
          .where(eq(rolePermissions.roleId, created.id))
          .catch(() => undefined);
        await db
          .delete(roles)
          .where(eq(roles.id, created.id))
          .catch(() => undefined);
      }
    });
  }
});

describe('SQL injection — PUT /api/v1/roles/:id (name body)', () => {
  for (const payload of PAYLOADS) {
    it(`survives name="${payload}"`, async () => {
      const freshId = uuidv7();
      await db.insert(roles).values({
        id: freshId,
        name: `sqli-put-${freshId.slice(0, 8)}`,
        color: 'neutral',
        isSystemRole: false,
      });

      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/roles/${freshId}`,
        headers: { cookie: ownerCookie },
        payload: { name: payload.slice(0, 64) },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(500);
      expect(await tablesExist()).toBe(true);

      await db
        .delete(rolePermissions)
        .where(eq(rolePermissions.roleId, freshId))
        .catch(() => undefined);
      await db
        .delete(roles)
        .where(eq(roles.id, freshId))
        .catch(() => undefined);
    });
  }
});

describe('SQL injection — POST /api/v1/servers (slug body)', () => {
  for (const payload of PAYLOADS) {
    it(`survives slug="${payload}"`, async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/servers',
        headers: { cookie: ownerCookie },
        payload: {
          display_name: 'SQLi Slug Test',
          slug: payload,
          game_port: 7800,
          query_port: 27200,
          beacon_port: 15100,
          rcon_port: 21200,
          max_players: 80,
          tickrate: 50,
          multihome: '0.0.0.0',
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(500);
      expect(await tablesExist()).toBe(true);
    });
  }
});

describe('SQL injection — GET /api/v1/audit?q=<payload>', () => {
  for (const payload of PAYLOADS) {
    it(`survives q="${payload}"`, async () => {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/v1/audit?q=${encodeURIComponent(payload)}`,
        headers: { cookie: ownerCookie },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(500);
      expect(await tablesExist()).toBe(true);
    });
  }
});

describe('SQL injection — PUT /api/v1/players/:steamId/role (role_id body)', () => {
  for (const payload of PAYLOADS) {
    it(`survives role_id="${payload}"`, async () => {
      const steamId = testSteamId(600100);
      const stub = 'SQLiPlayer';
      await db
        .insert(players)
        .values({
          steamId64: steamId,
          canonicalName: stub,
          canonicalNameNormalized: stub.toLowerCase(),
          roleId: null,
        })
        .onConflictDoNothing();

      const res = await h.app.inject({
        method: 'PUT',
        url: `/api/v1/players/${steamId}/role`,
        headers: { cookie: ownerCookie },
        payload: { role_id: payload },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(500);
      expect(await tablesExist()).toBe(true);
    });
  }
});
