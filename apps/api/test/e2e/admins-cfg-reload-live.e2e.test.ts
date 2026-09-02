/**
 * Real end-to-end verification of SYNC-3 correction №1: after the config-sync
 * worker rewrites a server's `Admins.cfg` managed segment it must fire RCON
 * `AdminReloadServerConfig` so permission changes take effect WITHOUT a
 * container restart.
 *
 * This drives the LIVE panel + LIVE config-sync worker + LIVE worker-rcon + a
 * LIVE Squad container: it force-syncs a running server (guaranteeing a write),
 * waits for the worker to publish `admins-cfg:status:<id> = in_sync`, and asserts
 * the corresponding outbox row reaches durable `reload_outcome=confirmed`.
 *
 * Prerequisites (this is a tier-3 / run-deferred spec — `test/e2e/**` is excluded
 * from the default vitest run): docker compose stack up, at least one Squad server
 * in status=running whose RCON listener is CONNECTED (`rcon:status:<id>.state ===
 * 'connected'`). When those aren't present the test SKIPS with a clear
 * `console.warn` rather than failing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from '@squad/db';
import { adminsCfgSyncOutbox, players, roles, servers, sessions } from '@squad/db/schema';
import { and, desc, eq, gte } from 'drizzle-orm';
import Redis from 'ioredis';
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

const PG_PASSWORD = dotenv('POSTGRES_PASSWORD') ?? 'admin';
const LIVE_DB_URL = `postgres://admin:${PG_PASSWORD}@127.0.0.1:5432/admin`;
const REDIS_URL = dotenv('REDIS_URL') ?? 'redis://127.0.0.1:6379';
const PANEL_URL = process.env.PANEL_URL ?? 'https://squad-panel.lan';
const TEST_STEAM_ID = 76561198999999002n;

let db: ReturnType<typeof createDatabaseClient>;
let redis: Redis;
let sessionTokenId: string;
let cookie: string;

beforeAll(async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  db = createDatabaseClient(LIVE_DB_URL);
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

  const ownerRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.name, 'Owner'), eq(roles.isSystemRole, true)))
    .limit(1);
  const ownerRoleId = ownerRows[0]?.id;
  if (!ownerRoleId) throw new Error('no Owner role seeded in live DB');

  await db
    .insert(players)
    .values({
      steamId64: TEST_STEAM_ID,
      canonicalName: 'E2E Reload Player',
      canonicalNameNormalized: 'e2e reload player',
      roleId: ownerRoleId,
    })
    .onConflictDoUpdate({ target: players.steamId64, set: { roleId: ownerRoleId } });

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
    .update(players)
    .set({ roleId: null })
    .where(eq(players.steamId64, TEST_STEAM_ID))
    .catch(() => undefined);
  await db
    .delete(players)
    .where(eq(players.steamId64, TEST_STEAM_ID))
    .catch(() => undefined);
  await redis?.quit().catch(() => undefined);
}, 30_000);

async function rconState(serverId: string): Promise<string | null> {
  const raw = await redis.get(`rcon:status:${serverId}`);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { state?: string }).state ?? null;
  } catch {
    return null;
  }
}

describe('config-sync fires AdminReloadServerConfig after Admins.cfg write (live)', () => {
  it('force-sync writes the file and durably confirms the RCON reload', async () => {
    const allServers = await db.select({ id: servers.id, status: servers.status }).from(servers);
    const running = allServers.find((s) => s.status === 'running' || s.status === 'starting');
    if (!running) {
      console.warn(
        'SKIPPED: no server in status=running; start one in the UI before running this spec',
      );
      return;
    }
    if ((await rconState(running.id)) !== 'connected') {
      console.warn(
        `SKIPPED: rcon:status:${running.id} is not 'connected' — the reload gate requires a live RCON listener`,
      );
      return;
    }

    const streamKey = `rcon:commands:${running.id}`;
    const beforeLen = await redis.xlen(streamKey);
    const requestedAt = new Date();

    const syncResp = await fetch(`${PANEL_URL}/api/v1/admins-cfg/sync?server_id=${running.id}`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(syncResp.status, await syncResp.clone().text()).toBe(200);

    // Wait for the worker to process the force-sync event: status flips to
    // in_sync once the file has been written (and the reload requested).
    let synced = false;
    for (let i = 0; i < 30; i++) {
      const raw = await redis.get(`admins-cfg:status:${running.id}`);
      if (raw) {
        try {
          const status = JSON.parse(raw) as { state?: string };
          if (status.state === 'in_sync') {
            synced = true;
            break;
          }
        } catch {
          // keep polling
        }
      }
      await sleep(500);
    }
    expect(synced, 'worker did not reach in_sync within 15s').toBe(true);

    // Primary assertion — PostgreSQL, not the ephemeral Redis result, is the
    // durable proof that the exact reload succeeded.
    let delivery: { appliedAt: Date | null; reloadOutcome: string | null } | undefined;
    for (let i = 0; i < 30; i++) {
      const rows = await db
        .select({
          payload: adminsCfgSyncOutbox.payload,
          appliedAt: adminsCfgSyncOutbox.appliedAt,
          reloadOutcome: adminsCfgSyncOutbox.reloadOutcome,
        })
        .from(adminsCfgSyncOutbox)
        .where(
          and(
            eq(adminsCfgSyncOutbox.serverId, running.id),
            gte(adminsCfgSyncOutbox.createdAt, requestedAt),
          ),
        )
        .orderBy(desc(adminsCfgSyncOutbox.createdAt));
      delivery = rows.find((row) => (row.payload as { reason?: string }).reason === 'force_sync');
      if (delivery?.appliedAt) break;
      await sleep(500);
    }
    expect(delivery).toMatchObject({
      appliedAt: expect.any(Date),
      reloadOutcome: 'confirmed',
    });

    // Secondary, direct signal — an AdminReloadServerConfig request hit the
    // worker-rcon stream (worker-rcon may already have consumed/trimmed it, so
    // this is best-effort corroboration, not the load-bearing assertion).
    const afterLen = await redis.xlen(streamKey);
    if (afterLen <= beforeLen) {
      console.warn(
        `rcon:commands stream length did not grow (${beforeLen}→${afterLen}) — worker-rcon likely already consumed the reload; PostgreSQL outbox confirmation remains authoritative`,
      );
    }
  }, 30_000);
});
