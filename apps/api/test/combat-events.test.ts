import type { DatabaseClient } from '@squad/db';
import { players, roles, servers } from '@squad/db/schema';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import { createSession } from '../src/lib/sessions.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const STEAM_RUN_BASE = 76561198100000000n + BigInt(Date.now() % 1_000_000_000);
const OWNER_STEAM_ID = STEAM_RUN_BASE + 5_000_000n;
let steamCounter = STEAM_RUN_BASE;
function nextSteam(): bigint {
  steamCounter += 1n;
  return steamCounter;
}

async function seedRole(
  db: DatabaseClient,
  opts: { panelAccess?: boolean; combatView?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(roles).values({
    id,
    name: `CombatRole-${id.slice(0, 12)}`,
    color: 'neutral',
    isSystemRole: false,
    panelAccess: opts.panelAccess ?? true,
    combatView: opts.combatView ?? true,
  });
  return id;
}

async function seedPlayer(
  db: DatabaseClient,
  opts: { name?: string; roleId?: string | null } = {},
): Promise<string> {
  const id = uuidv7();
  const name = opts.name ?? `Combatant-${id.slice(0, 8)}`;
  await db.insert(players).values({
    id,
    steamId64: nextSteam(),
    canonicalName: name,
    canonicalNameNormalized: name.toLowerCase(),
    roleId: opts.roleId ?? null,
  });
  return id;
}

async function seedServer(db: DatabaseClient, name: string): Promise<string> {
  const id = uuidv7();
  await db.insert(servers).values({
    id,
    displayName: name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${id}`,
  });
  return id;
}

async function loginAs(h: IntegrationHarness, playerId: string): Promise<string> {
  invalidatePermissionCache(playerId);
  const { token } = await createSession(h.db, h.redis, {
    playerId,
    ip: null,
    userAgent: 'combat-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface CombatSide {
  player_id: string;
  current_name: string;
}
interface CombatRow {
  id: number;
  eventType: string;
  serverId: string;
  matchId: number | null;
  weapon: string | null;
  damage: string | null;
  attackerKit: string | null;
  isTeamkill: boolean;
  occurredAt: string;
  attacker: CombatSide | null;
  victim: CombatSide;
}
interface ListResponse {
  rows: CombatRow[];
  nextCursor: string | null;
  approxTotal: number;
}

const BASE = new Date();
BASE.setUTCDate(15);
BASE.setUTCHours(12, 0, 0, 0);

describeIfDb('combat-events API (COMBAT-3)', () => {
  let h: IntegrationHarness;
  let ownerCookie: string;
  let serverA: string;
  let serverB: string;
  let sniper: string;
  let target: string;
  let medic: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
      reusePublicSchema: true,
    });
    // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
    ownerCookie = await loginAs(h, h.seed.ownerPlayerId!);

    serverA = await seedServer(h.db, 'Alpha');
    serverB = await seedServer(h.db, 'Bravo');
    sniper = await seedPlayer(h.db, { name: 'SniperWolf' });
    target = await seedPlayer(h.db, { name: 'TargetDummy' });
    medic = await seedPlayer(h.db, { name: 'FieldMedic' });

    await h.db.execute(sql`
      INSERT INTO combat_events
        (event_type, server_id, match_id, attacker_player_id, victim_player_id,
         weapon, damage, attacker_kit, is_teamkill, occurred_at)
      SELECT
        (ARRAY['death','damage','wound','revive'])[1 + (g % 4)],
        ${serverA}::uuid,
        4200,
        ${sniper}::uuid,
        ${target}::uuid,
        (ARRAY['AK-74','M4A1','M249 SAW'])[1 + (g % 3)],
        (g % 100)::numeric,
        'Rifleman',
        (g % 25 = 0),
        ${BASE.toISOString()}::timestamptz - (g * interval '1 minute')
      FROM generate_series(1, 4000) AS g
    `);

    await h.db.execute(sql`
      INSERT INTO combat_events
        (event_type, server_id, match_id, attacker_player_id, victim_player_id,
         weapon, damage, attacker_kit, is_teamkill, occurred_at)
      VALUES
        ('death', ${serverB}::uuid, 9001, ${sniper}::uuid, ${target}::uuid,
         'SVD Dragunov', 130, 'Marksman', false, ${BASE.toISOString()}::timestamptz + interval '1 hour'),
        ('death', ${serverB}::uuid, 9001, ${sniper}::uuid, ${target}::uuid,
         'SVD Dragunov', 145, 'Marksman', true, ${BASE.toISOString()}::timestamptz + interval '2 hour'),
        ('revive', ${serverB}::uuid, 9001, ${medic}::uuid, ${target}::uuid,
         NULL, NULL, 'Medic', false, ${BASE.toISOString()}::timestamptz + interval '3 hour')
    `);
  });

  afterAll(async () => {
    await h.db.execute(
      sql`DELETE FROM combat_events WHERE server_id IN (${serverA}::uuid, ${serverB}::uuid)`,
    );
    await h.cleanup();
  });

  async function list(qs: string, cookie = ownerCookie): Promise<ListResponse> {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/combat-events${qs}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as ListResponse;
  }

  it('returns 403 without combat:view even when the role has panel access', async () => {
    const gatedRole = await seedRole(h.db, { panelAccess: true, combatView: false });
    const gatedPlayer = await seedPlayer(h.db, { roleId: gatedRole });
    const gatedCookie = await loginAs(h, gatedPlayer);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/combat-events',
      headers: { cookie: gatedCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  it('grants access to a role that has combat:view', async () => {
    const okRole = await seedRole(h.db, { panelAccess: true, combatView: true });
    const okPlayer = await seedPlayer(h.db, { roleId: okRole });
    const okCookie = await loginAs(h, okPlayer);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/combat-events?limit=1',
      headers: { cookie: okCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns both sides with player_id and current_name', async () => {
    const body = await list(`?serverId=${serverB}&type=revive`);
    expect(body.rows).toHaveLength(1);
    const revive = body.rows[0];
    expect(revive.eventType).toBe('revive');
    expect(revive.attacker).toEqual({ player_id: medic, current_name: 'FieldMedic' });
    expect(revive.victim).toEqual({ player_id: target, current_name: 'TargetDummy' });
    expect(revive.weapon).toBeNull();
  });

  it('applies combined filters (player + weapon + server + period)', async () => {
    const from = new Date(BASE.getTime() + 30 * 60_000).toISOString();
    const to = new Date(BASE.getTime() + 4 * 3_600_000).toISOString();
    const body = await list(
      `?serverId=${serverB}&attackerPlayerId=${sniper}&weapon=dragunov&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((r) => r.weapon === 'SVD Dragunov')).toBe(true);
    expect(body.rows.every((r) => r.serverId === serverB)).toBe(true);
    expect(body.approxTotal).toBe(2);
  });

  it('filters teamkills only', async () => {
    const body = await list(`?serverId=${serverB}&teamkillsOnly=true`);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].isTeamkill).toBe(true);
    expect(body.approxTotal).toBe(1);
  });

  it('matches a player on either side via playerId', async () => {
    const body = await list(`?serverId=${serverB}&playerId=${medic}`);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].attacker?.player_id).toBe(medic);
  });

  it('resolves attackerName substring against the current name', async () => {
    const body = await list(`?serverId=${serverB}&attackerName=medic`);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].attacker?.current_name).toBe('FieldMedic');
  });

  it('paginates deep via keyset with correct ordering and no gaps, each page < 500ms', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let prevAt = Number.POSITIVE_INFINITY;
    let prevId = Number.POSITIVE_INFINITY;

    do {
      const qs = `?serverId=${serverA}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const started = performance.now();
      const body: ListResponse = await list(qs);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(500);

      for (const row of body.rows) {
        const at = new Date(row.occurredAt).getTime();
        expect(at <= prevAt).toBe(true);
        if (at === prevAt) expect(row.id).toBeLessThan(prevId);
        prevAt = at;
        prevId = row.id;
        seen.push(row.id);
      }
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(50);
    } while (cursor);

    expect(seen).toHaveLength(4000);
    expect(new Set(seen).size).toBe(4000);
  });

  it('reports an exact approxTotal when filters are active', async () => {
    const body = await list(`?serverId=${serverA}&type=death`);
    expect(body.approxTotal).toBe(1000);
  });

  it('streams a CSV export with header and all matching rows', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/combat-events/export?serverId=${serverA}&type=death`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');

    const lines = res.payload.trim().split('\r\n');
    expect(lines[0]).toBe(
      'id,event_type,server_id,match_id,occurred_at,attacker_player_id,attacker_name,victim_player_id,victim_name,weapon,damage,attacker_kit,is_teamkill',
    );
    expect(lines).toHaveLength(1001);
    expect(lines[1]).toContain('death');
    expect(lines[1]).toContain('SniperWolf');
    expect(lines[1]).toContain('TargetDummy');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/combat-events' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid cursor', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/combat-events?cursor=not-a-valid-cursor',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(400);
  });
});
