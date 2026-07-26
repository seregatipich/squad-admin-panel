import type { DatabaseClient } from '@squad/db';
import { moderationActions, players, roles, servers } from '@squad/db/schema';
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

const STEAM_RUN_BASE = 76561198200000000n + BigInt(Date.now() % 1_000_000_000);
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
    name: `TeamkillRole-${id}`,
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
  const name = opts.name ?? `Teamkiller-${id.slice(0, 8)}`;
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
    userAgent: 'teamkills-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface TeamkillSummaryRow {
  player_id: string;
  current_name: string | null;
  steam_id64: string | null;
  eos_id: string | null;
  tk_total: number;
  tk_7d: number;
  tk_30d: number;
  victim_of_tk_total: number;
  last_tk_at: string;
  moderation_total: number;
  last_moderation_at: string | null;
  last_moderation_type: string | null;
}

interface TeamkillSummaryResponse {
  generated_at: string;
  rows: TeamkillSummaryRow[];
}

interface TeamkillPlayerEvent {
  id: number;
  server_id: string;
  match_id: number | null;
  weapon: string | null;
  occurred_at: string;
  role: 'attacker' | 'victim';
  attacker: { player_id: string; current_name: string | null } | null;
  victim: { player_id: string; current_name: string | null } | null;
}

interface TeamkillPlayerResponse {
  stats: TeamkillSummaryRow;
  recent: TeamkillPlayerEvent[];
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describeIfDb('teamkill moderation API (COMBAT-5)', () => {
  let h: IntegrationHarness;
  let ownerCookie: string;
  let serverId: string;
  let otherServerId: string;
  let alpha: string;
  let bravo: string;
  let charlie: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({
      seedOwner: { steamId64: OWNER_STEAM_ID },
      bridge: makeFakeBridge(),
      reusePublicSchema: true,
    });
    // biome-ignore lint/style/noNonNullAssertion: seedOwner guarantees ownerPlayerId
    ownerCookie = await loginAs(h, h.seed.ownerPlayerId!);

    serverId = await seedServer(h.db, 'Teamkill Alpha');
    otherServerId = await seedServer(h.db, 'Teamkill Bravo');
    alpha = await seedPlayer(h.db, { name: 'Alpha TK' });
    bravo = await seedPlayer(h.db, { name: 'Bravo Victim' });
    charlie = await seedPlayer(h.db, { name: 'Charlie TK' });

    for (let i = 0; i < 9; i += 1) {
      await h.db.execute(sql`
        INSERT INTO combat_events
          (event_type, server_id, match_id, attacker_player_id, victim_player_id,
           weapon, is_teamkill, occurred_at)
        VALUES
          ('death', ${serverId}::uuid, 5001, ${alpha}::uuid, ${bravo}::uuid,
           ${`Rifle ${i}`}, true, ${minutesAgo(60 + i)}::timestamptz)
      `);
    }

    await h.db.execute(sql`
      INSERT INTO combat_events
        (event_type, server_id, match_id, attacker_player_id, victim_player_id,
         weapon, is_teamkill, occurred_at)
      VALUES
        ('death', ${serverId}::uuid, 5001, ${alpha}::uuid, ${bravo}::uuid,
         'Grenade', true, ${daysAgo(10)}::timestamptz),
        ('death', ${serverId}::uuid, 5001, ${alpha}::uuid, ${bravo}::uuid,
         'Mortar', true, ${daysAgo(40)}::timestamptz),
        ('death', ${serverId}::uuid, 5001, ${charlie}::uuid, ${alpha}::uuid,
         'LAT', true, ${minutesAgo(30)}::timestamptz),
        ('death', ${serverId}::uuid, 5001, ${charlie}::uuid, ${alpha}::uuid,
         'HAT', true, ${minutesAgo(90)}::timestamptz),
        ('death', ${serverId}::uuid, 5001, ${charlie}::uuid, ${bravo}::uuid,
         'BTR', true, ${daysAgo(20)}::timestamptz),
        ('death', ${serverId}::uuid, 5001, ${alpha}::uuid, ${charlie}::uuid,
         'Not counted', false, ${minutesAgo(5)}::timestamptz),
        ('death', ${otherServerId}::uuid, 5002, ${charlie}::uuid, ${bravo}::uuid,
         'Other server', true, ${minutesAgo(10)}::timestamptz)
    `);

    // Alpha has one active (non-reverted) warn and one reverted kick — only the
    // active warn should count toward moderation_total / last_moderation_type.
    await h.db.insert(moderationActions).values({
      playerId: alpha,
      actionType: 'warn',
      authorSystemLabel: 'teamkills-test',
      reason: 'excessive teamkills',
      createdAt: new Date(Date.now() - 60 * 60_000),
    });
    await h.db.insert(moderationActions).values({
      playerId: alpha,
      actionType: 'kick',
      authorSystemLabel: 'teamkills-test',
      reason: 'reverted kick',
      createdAt: new Date(Date.now() - 2 * 60 * 60_000),
      revertedAt: new Date(),
    });
    // Charlie has zero moderation_actions — asserts the zero/null default path.
  });

  afterAll(async () => {
    await h.db.execute(
      sql`DELETE FROM combat_events WHERE server_id IN (${serverId}::uuid, ${otherServerId}::uuid)`,
    );
    await h.db.execute(
      sql`DELETE FROM moderation_actions WHERE player_id IN (${alpha}::uuid, ${bravo}::uuid, ${charlie}::uuid)`,
    );
    await h.cleanup();
  });

  it('returns top offenders with rolling windows and victim counts', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/moderation/teamkills?serverId=${serverId}&sort=tk_7d&limit=5`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as TeamkillSummaryResponse;
    expect(new Date(body.generated_at).getTime()).not.toBeNaN();
    expect(body.rows.map((row) => row.player_id)).toEqual([alpha, charlie]);
    expect(body.rows[0]).toMatchObject({
      player_id: alpha,
      current_name: 'Alpha TK',
      tk_total: 11,
      tk_7d: 9,
      tk_30d: 10,
      victim_of_tk_total: 2,
      moderation_total: 1,
      last_moderation_type: 'warn',
    });
    expect(new Date(body.rows[0].last_moderation_at as string).getTime()).not.toBeNaN();
    expect(body.rows[1]).toMatchObject({
      player_id: charlie,
      current_name: 'Charlie TK',
      tk_total: 3,
      tk_7d: 2,
      tk_30d: 3,
      victim_of_tk_total: 0,
      moderation_total: 0,
      last_moderation_at: null,
      last_moderation_type: null,
    });
  });

  it('returns player stats and the latest 10 teamkill events involving the player', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${alpha}/teamkills?serverId=${serverId}`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as TeamkillPlayerResponse;
    expect(body.stats).toMatchObject({
      player_id: alpha,
      current_name: 'Alpha TK',
      tk_total: 11,
      tk_7d: 9,
      tk_30d: 10,
      victim_of_tk_total: 2,
      moderation_total: 1,
      last_moderation_type: 'warn',
    });
    expect(new Date(body.stats.last_moderation_at as string).getTime()).not.toBeNaN();
    expect(body.recent).toHaveLength(10);
    expect(body.recent[0]).toMatchObject({
      role: 'victim',
      attacker: { player_id: charlie, current_name: 'Charlie TK' },
      victim: { player_id: alpha, current_name: 'Alpha TK' },
      weapon: 'LAT',
    });
    expect(body.recent.every((event) => event.server_id === serverId)).toBe(true);
    expect(
      body.recent.every(
        (event) => event.attacker?.player_id === alpha || event.victim?.player_id === alpha,
      ),
    ).toBe(true);
  });

  it('does not scope moderation counts by serverId — the filter only bounds combat_events', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${alpha}/teamkills?serverId=${otherServerId}`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as TeamkillPlayerResponse;
    // Alpha has zero TK events on otherServerId, but the warn (server-less)
    // must still be reported.
    expect(body.stats).toMatchObject({
      tk_total: 0,
      tk_7d: 0,
      tk_30d: 0,
      moderation_total: 1,
      last_moderation_type: 'warn',
    });
  });

  it('rejects viewers without combat:view', async () => {
    const gatedRole = await seedRole(h.db, { panelAccess: true, combatView: false });
    const gatedPlayer = await seedPlayer(h.db, { roleId: gatedRole });
    const gatedCookie = await loginAs(h, gatedPlayer);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/moderation/teamkills',
      headers: { cookie: gatedCookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/moderation/teamkills' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthenticated' });
  });
});
