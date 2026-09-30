/**
 * Issue #30 (finding #1254): Redis is reachable by every local process and by
 * the RNSquadJS sidecar, so a `session:<sha256(token)>` entry must not be able
 * to grant a session on its own — neither a forged entry for a token of the
 * attacker's choosing nor a tampered entry of the attacker's own session.
 */
import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, mintSessionToken } from '../../src/lib/sessions.js';
import { SESSION_COOKIE } from '../../src/plugins/auth.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from '../integration/harness.js';

const OWNER_STEAM = testSteamId(840001);
const ATTACKER_STEAM = testSteamId(840002);

let h: IntegrationHarness;
let ownerPlayerId: string;
let attackerPlayerId: string;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  if (!h.seed.ownerPlayerId) throw new Error('owner not seeded');
  ownerPlayerId = h.seed.ownerPlayerId;
  const [attacker] = await h.db
    .insert(players)
    .values({
      steamId64: ATTACKER_STEAM,
      canonicalName: 'CacheAttacker',
      canonicalNameNormalized: 'cacheattacker',
    })
    .returning({ id: players.id });
  if (!attacker) throw new Error('attacker not seeded');
  attackerPlayerId = attacker.id;
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
}, 60_000);

async function me(token: string) {
  return h.app.inject({ method: 'GET', url: '/api/v1/me', cookies: { [SESSION_COOKIE]: token } });
}

describe('session cache integrity (#30, finding #1254)', () => {
  it('rejects a session forged straight into Redis for a token of the attacker’s choosing', async () => {
    const { token, tokenId } = mintSessionToken();
    const now = new Date();
    await h.redis.set(
      `session:${tokenId}`,
      JSON.stringify({
        playerId: ownerPlayerId,
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        lastActivityAt: now.toISOString(),
        ip: null,
        userAgent: null,
        scope: 'panel',
      }),
      'EX',
      600,
    );

    const res = await me(token);
    expect(res.statusCode).toBe(401);
  });

  it('ignores a tampered cache entry of a real session and keeps its real owner', async () => {
    const { token, session } = await createSession(h.db, h.redis, {
      playerId: attackerPlayerId,
      ip: null,
      userAgent: 'cache-forgery-test',
      ttlMs: 3_600_000,
    });
    const key = `session:${session.id}`;
    const cached = await h.redis.get(key);
    expect(cached).not.toBeNull();
    await h.redis.set(key, (cached ?? '').replaceAll(attackerPlayerId, ownerPlayerId), 'EX', 600);

    const res = await me(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ steam_id64: String(ATTACKER_STEAM) });
  });

  it('still serves a genuine session from the cache', async () => {
    const { token } = await createSession(h.db, h.redis, {
      playerId: attackerPlayerId,
      ip: null,
      userAgent: 'cache-forgery-test',
      ttlMs: 3_600_000,
    });
    const first = await me(token);
    const second = await me(token);
    expect(first.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ steam_id64: String(ATTACKER_STEAM) });
    const [row] = await h.db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.steamId64, ATTACKER_STEAM));
    expect(row?.id).toBe(attackerPlayerId);
  });
});
