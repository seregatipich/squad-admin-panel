import { auditLog, playerIpHistory, playerLinks, players } from '@squad/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(820001);
const PLAYER_A = testSteamId(820002);
const PLAYER_B = testSteamId(820003);
const PLAYER_C = testSteamId(820004);
const TEST_PLAYER_LIMITED_VIEWER = testSteamId(820005);

let h: IntegrationHarness;

async function seedPlayer(steamId64: bigint | null, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
    })
    .returning({ id: players.id });
  return row.id;
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player found for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'player-links-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

// Every SteamID-bearing player a case may seed besides the owner.
const TEST_PLAYER_STEAM_IDS = [PLAYER_A, PLAYER_B, PLAYER_C, TEST_PLAYER_LIMITED_VIEWER];

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  // Cases re-seed the same SteamIDs, and alt candidates match on IPs shared
  // with any player: drop this case's links, IP history and fixture players.
  await h.db.delete(playerLinks);
  await h.db.delete(playerIpHistory);
  await h.db.delete(players).where(inArray(players.steamId64, TEST_PLAYER_STEAM_IDS));
});

afterAll(async () => {
  await h?.cleanup();
});

describe('POST /api/v1/players/:playerId/links', () => {
  it('confirms a link and is idempotent regardless of which side confirms', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    const cookie = await loginAsOwner(h);

    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ other_player_id: idB, link_type: 'alt' }),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      id: string;
      link_type: string;
      status: string;
      other_player: { id: string };
    };
    expect(body.link_type).toBe('alt');
    expect(body.status).toBe('confirmed');
    expect(body.other_player.id).toBe(idB);

    // Confirming from the opposite side of the same pair is a duplicate → 409.
    const duplicate = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idB}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ other_player_id: idA, link_type: 'alt' }),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'link_exists' });

    const rows = await h.db
      .select()
      .from(playerLinks)
      .where(
        and(
          eq(playerLinks.playerAId, idA < idB ? idA : idB),
          eq(playerLinks.playerBId, idA < idB ? idB : idA),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].playerAId < rows[0].playerBId).toBe(true);
  });

  it('creates a rejected link that then marks the pair in the full ALT-1 candidate output', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idB, ip: '203.0.113.10' },
    ]);
    const cookie = await loginAsOwner(h);

    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ other_player_id: idB, link_type: 'unrelated', status: 'rejected' }),
    });
    expect(created.statusCode).toBe(201);

    const candidates = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    expect(candidates.statusCode).toBe(200);
    const body = candidates.json() as {
      candidates: Array<{
        player_id: string;
        link: { status: string; link_type: string; decided_by_name: string | null } | null;
      }>;
    };
    expect(body.candidates).toHaveLength(1);
    const candidateB = body.candidates.find((c) => c.player_id === idB);
    expect(candidateB?.link).toMatchObject({ status: 'rejected', link_type: 'unrelated' });
    expect(candidateB?.link?.decided_by_name).toBeTruthy();
  });

  it('links an EOS-only counterpart (steam_id64 NULL) without error', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idEos = await seedPlayer(null, 'EosOnlyPlayer');
    const cookie = await loginAsOwner(h);

    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ other_player_id: idEos, link_type: 'alt' }),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { other_player: { steam_id64: string | null } };
    expect(body.other_player.steam_id64).toBeNull();
  });

  it('rejects a self-link with 400', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ other_player_id: idA, link_type: 'alt' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'self_link' });
  });

  it('rejects an unknown other_player_id with 404', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        other_player_id: '00000000-0000-0000-0000-000000000000',
        link_type: 'alt',
      }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'player_not_found' });
  });

  it('rejects an invalid link_type with 400', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ other_player_id: idB, link_type: 'shared_pc' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unauthenticated request', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ other_player_id: idB, link_type: 'alt' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a logged-in user whose role lacks can_view_ips', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    await seedPlayer(TEST_PLAYER_LIMITED_VIEWER, 'LimitedViewer');

    const ownerCookie = await loginAsOwner(h);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: `no-view-ips-links-${Date.now()}`,
        color: '#123456',
        squad_permissions: [],
        panel_access: true,
        can_view_ips: false,
      }),
    });
    expect(created.statusCode).toBe(201);
    const roleId = (created.json() as { id: string }).id;
    await h.db
      .update(players)
      .set({ roleId })
      .where(eq(players.steamId64, TEST_PLAYER_LIMITED_VIEWER));
    invalidateAllPermissionCaches();

    const cookie = await loginAsSteam(TEST_PLAYER_LIMITED_VIEWER);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ other_player_id: idB, link_type: 'alt' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('writes an audit_log entry with the evidence_snapshot on create', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    const cookie = await loginAsOwner(h);

    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        other_player_id: idB,
        link_type: 'alt',
        evidence_snapshot: { score: 75, confidence: 'high', shared_ip_count: 2 },
      }),
    });
    expect(created.statusCode).toBe(201);
    const linkId = (created.json() as { id: string }).id;

    const auditRows = await h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetType, 'player_link'), eq(auditLog.targetId, linkId)));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].beforeSnapshot).toBeNull();
    expect(auditRows[0].afterSnapshot).toMatchObject({
      evidenceSnapshot: { score: 75, confidence: 'high', shared_ip_count: 2 },
    });
  });
});

describe('PATCH /api/v1/player-links/:linkId', () => {
  async function createLink(idA: string, idB: string, cookie: string): Promise<string> {
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ other_player_id: idB, link_type: 'alt' }),
    });
    return (created.json() as { id: string }).id;
  }

  it('flips status and link_type, bumping updated_at', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    const cookie = await loginAsOwner(h);
    const linkId = await createLink(idA, idB, cookie);

    const [before] = await h.db.select().from(playerLinks).where(eq(playerLinks.id, linkId));

    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/player-links/${linkId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'rejected', link_type: 'unrelated' }),
    });
    expect(patched.statusCode).toBe(200);
    const body = patched.json() as { status: string; link_type: string };
    expect(body.status).toBe('rejected');
    expect(body.link_type).toBe('unrelated');

    const [after] = await h.db.select().from(playerLinks).where(eq(playerLinks.id, linkId));
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it('returns 404 for an unknown link id', async () => {
    const cookie = await loginAsOwner(h);
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/player-links/00000000-0000-0000-0000-000000000000',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'rejected' }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'link_not_found' });
  });

  it('rejects an empty body with 400', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    const cookie = await loginAsOwner(h);
    const linkId = await createLink(idA, idB, cookie);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/player-links/${linkId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it('writes an audit_log entry whose before/after differ', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    const cookie = await loginAsOwner(h);
    const linkId = await createLink(idA, idB, cookie);

    const patched = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/player-links/${linkId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'rejected' }),
    });
    expect(patched.statusCode).toBe(200);

    const auditRows = await h.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, 'player_link'),
          eq(auditLog.targetId, linkId),
          eq(auditLog.actionType, 'player_link.update'),
        ),
      );
    expect(auditRows).toHaveLength(1);
    const before = auditRows[0].beforeSnapshot as { status: string };
    const after = auditRows[0].afterSnapshot as { status: string };
    expect(before.status).toBe('confirmed');
    expect(after.status).toBe('rejected');
  });
});

describe('GET /api/v1/players/:playerId/links', () => {
  it('returns the link from both players perspectives with the correct other_player', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idB = await seedPlayer(PLAYER_B, 'PlayerB');
    const cookie = await loginAsOwner(h);

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ other_player_id: idB, link_type: 'family_share' }),
    });

    const fromA = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/links`,
      headers: { cookie },
    });
    const fromB = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idB}/links`,
      headers: { cookie },
    });
    const bodyA = fromA.json() as { links: Array<{ other_player: { id: string } }> };
    const bodyB = fromB.json() as { links: Array<{ other_player: { id: string } }> };
    expect(bodyA.links).toHaveLength(1);
    expect(bodyB.links).toHaveLength(1);
    expect(bodyA.links[0].other_player.id).toBe(idB);
    expect(bodyB.links[0].other_player.id).toBe(idA);
  });

  it('rejects an unauthenticated request', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/players/${idA}/links` });
    expect(res.statusCode).toBe(401);
  });
});

describe('link annotation on GET /api/v1/players/:playerId/alt-candidates', () => {
  it('is null for a shared-IP pair with no player_links decision (regression on ALT-1 shape)', async () => {
    const idA = await seedPlayer(PLAYER_A, 'PlayerA');
    const idC = await seedPlayer(PLAYER_C, 'PlayerC');
    await h.db.insert(playerIpHistory).values([
      { playerId: idA, ip: '203.0.113.10' },
      { playerId: idC, ip: '203.0.113.10' },
    ]);
    const cookie = await loginAsOwner(h);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${idA}/alt-candidates`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { candidates: Array<{ player_id: string; link: unknown }> };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].player_id).toBe(idC);
    expect(body.candidates[0].link).toBeNull();
  });
});
