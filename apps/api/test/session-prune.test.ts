import { sessions } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, pruneExpired } from '../src/lib/sessions.js';
import { sessionPrunePlugin } from '../src/plugins/session-prune.js';
import { testSteamId } from './helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness } from './integration/harness.js';

// Regression for #37 finding #1317: expired sessions were never deleted —
// pruneExpired had no caller, and its `rowCount` cast always reported 0
// because postgres.js exposes the affected-row count as `count`.

let h: IntegrationHarness;
let playerId: string;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: testSteamId(917_001) } });
  playerId = h.seed.ownerPlayerId as string;
});

afterAll(async () => {
  await h?.cleanup();
});

async function mintSession(ttlMs: number): Promise<string> {
  const { session } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'session-prune-test',
    ttlMs,
  });
  return session.id;
}

async function sessionExists(id: string): Promise<boolean> {
  const rows = await h.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id));
  return rows.length > 0;
}

describe('pruneExpired', () => {
  it('deletes only expired sessions and reports how many rows it removed', async () => {
    const expiredA = await mintSession(-60_000);
    const expiredB = await mintSession(-120_000);
    const live = await mintSession(3_600_000);

    const removed = await pruneExpired(h.db);

    // Other files sharing the database may hold expired rows too, so the
    // count is a lower bound; it must at least cover the two seeded here.
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await sessionExists(expiredA)).toBe(false);
    expect(await sessionExists(expiredB)).toBe(false);
    expect(await sessionExists(live)).toBe(true);
  });
});

describe('session-prune plugin', () => {
  it('removes expired sessions on each tick and stops its timer on close', async () => {
    const app = Fastify();
    app.decorate('db', h.db);
    await app.register(sessionPrunePlugin);
    await app.ready();
    try {
      const expired = await mintSession(-60_000);
      const live = await mintSession(3_600_000);

      await app.sessionPruneTick();

      expect(await sessionExists(expired)).toBe(false);
      expect(await sessionExists(live)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
