import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@squad/db';
import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const BASE_URL = process.env.PANEL_TEST_URL;
const COOKIE = process.env.PANEL_TEST_COOKIE;
const SECONDARY_STEAM_ID = process.env.PANEL_E2E_SECONDARY_STEAM_ID;

const PG_PASSWORD = dotenv('POSTGRES_PASSWORD') ?? 'admin';
const LIVE_DB_URL = `postgres://admin:${PG_PASSWORD}@127.0.0.1:5432/admin`;

const fetchOwner = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...init.headers, cookie: `__Host-sid=${COOKIE}` },
  });

describe.skipIf(!BASE_URL || !COOKIE || !SECONDARY_STEAM_ID)('panel RBAC e2e', () => {
  let db: ReturnType<typeof createDatabaseClient>;
  let secondarySeeded = false;

  beforeAll(async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    if (!SECONDARY_STEAM_ID) return;
    db = createDatabaseClient(LIVE_DB_URL);
    const steamId64 = BigInt(SECONDARY_STEAM_ID);
    const existing = await db
      .select({ steamId64: players.steamId64 })
      .from(players)
      .where(eq(players.steamId64, steamId64))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(players).values({
        steamId64,
        canonicalName: 'E2E Secondary Player',
        canonicalNameNormalized: 'e2e secondary player',
        roleId: null,
      });
      secondarySeeded = true;
    }
  }, 15_000);

  afterAll(async () => {
    if (!db || !SECONDARY_STEAM_ID) return;
    const steamId64 = BigInt(SECONDARY_STEAM_ID);
    await db
      .update(players)
      .set({ roleId: null })
      .where(eq(players.steamId64, steamId64))
      .catch(() => undefined);
    if (secondarySeeded) {
      await db
        .delete(players)
        .where(eq(players.steamId64, steamId64))
        .catch(() => undefined);
    }
  }, 15_000);

  it('full lifecycle: create role → assign → modify → revoke', async () => {
    let res = await fetchOwner('/api/v1/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `E2E_${Date.now()}`,
        color: 'blue',
        permissions: ['server:view'],
      }),
    });
    expect(res.status).toBe(201);
    const role = (await res.json()) as { id: string };

    try {
      res = await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: role.id }),
      });
      expect(res.status).toBe(200);

      res = await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`);
      expect(res.status).toBe(200);
      const assigned = (await res.json()) as { role: { id: string } | null };
      expect(assigned.role?.id).toBe(role.id);

      res = await fetchOwner(`/api/v1/roles/${role.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: [] }),
      });
      expect(res.status).toBe(200);

      res = await fetchOwner(`/api/v1/roles/${role.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      res = await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`);
      const after = (await res.json()) as { role: null };
      expect(after.role).toBeNull();
    } finally {
      await fetchOwner(`/api/v1/roles/${role.id}`, { method: 'DELETE' }).catch(() => {});
      await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: null }),
      }).catch(() => {});
    }
  });

  it('Owner-lockout: cannot remove last Owner', async () => {
    const meRes = await fetchOwner('/api/v1/me');
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { steam_id64: string };

    const res = await fetchOwner(`/api/v1/players/${me.steam_id64}/role`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: null }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('cannot_remove_last_owner');
  });
});
