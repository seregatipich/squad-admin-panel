import { auditLog, players, roles } from '@squad/db/schema';
import { and, desc, eq, gte } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import type { LiveEvent } from '../../src/plugins/live-bus.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(810001);
const EOS_ONLY_EOS = 'eos-mark1-000000000000000000000001';
const NO_PANEL_STEAM = testSteamId(810002);

let h: IntegrationHarness;
let ownerCookie: string;
let targetPlayerId: string;
let eosPlayerId: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'marks-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'MarkOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const [target] = await h.db
    .insert(players)
    .values({
      steamId64: testSteamId(810010),
      canonicalName: 'SuspectSteam',
      canonicalNameNormalized: 'suspectsteam',
    })
    .returning({ id: players.id });
  if (!target) throw new Error('failed to seed target player');
  targetPlayerId = target.id;

  const [eos] = await h.db
    .insert(players)
    .values({
      steamId64: null,
      eosId: EOS_ONLY_EOS,
      canonicalName: 'SuspectEos',
      canonicalNameNormalized: 'suspecteos',
    })
    .returning({ id: players.id });
  if (!eos) throw new Error('failed to seed eos player');
  eosPlayerId = eos.id;

  const queuePriority = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db
    .insert(players)
    .values({
      steamId64: NO_PANEL_STEAM,
      canonicalName: 'NoPanel',
      canonicalNameNormalized: 'nopanel',
      roleId: queuePriority[0]?.id ?? null,
    })
    .onConflictDoNothing();
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('GET /api/v1/mark-types', () => {
  it('returns the 8 seeded SQSTAT mark types ordered by sort_order', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/mark-types',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: number; slug: string; sort_order: number }>;
    expect(body).toHaveLength(8);
    expect(body.map((t) => t.slug)).toEqual([
      'wallhack',
      'aimbot',
      'speedhack',
      'object_spawn',
      'reload_exploit',
      'griefing',
      'illegal_config',
      'toxic',
    ]);
  });

  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/mark-types' });
    expect(res.statusCode).toBe(401);
  });
});

describeIfDb('POST /api/v1/players/:id/marks', () => {
  it('sets two marks of different types on a player', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetPlayerId}/marks`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 1, comment: 'walls' }),
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { active: boolean; mark_type_id: number; created_by: string };
    expect(firstBody.active).toBe(true);
    expect(firstBody.mark_type_id).toBe(1);
    expect(firstBody.created_by).toBe(h.seed.ownerPlayerId);

    const second = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetPlayerId}/marks`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 2 }),
    });
    expect(second.statusCode).toBe(201);

    const list = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetPlayerId}/marks`,
      headers: { cookie: ownerCookie },
    });
    const body = list.json() as { items: Array<{ mark_type_id: number }>; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((m) => m.mark_type_id).sort()).toEqual([1, 2]);
  });

  it('writes a player.mark.set audit entry with the actor', async () => {
    const row = await assertAuditRow(h, {
      action: 'player.mark.set',
      resource: 'player_mark',
    });
    expect(row.actorKind).toBe('steam');
    expect(row.actorPlayerId).toBe(h.seed.ownerPlayerId);
    expect(row.afterSnapshot).toMatchObject({ active: true });
  });

  it('rejects re-setting an already active mark type with 409', async () => {
    const dup = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetPlayerId}/marks`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 1 }),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'mark_already_active' });
  });

  it('marks an EOS-only player (steam_id64 NULL) without error', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${eosPlayerId}/marks`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 3 }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { player_id: string; active: boolean };
    expect(body.player_id).toBe(eosPlayerId);
    expect(body.active).toBe(true);
  });

  it('rejects unauthenticated set with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetPlayerId}/marks`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 4 }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a user without panel_access with 403', async () => {
    const cookie = await loginAsSteam(NO_PANEL_STEAM);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetPlayerId}/marks`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 4 }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });
});

describeIfDb('DELETE /api/v1/players/:id/marks/:markId', () => {
  it('clears a mark keeping the row with cleared_by/cleared_at, visible via include_cleared', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetPlayerId}/marks`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 6, comment: 'grief' }),
    });
    expect(created.statusCode).toBe(201);
    const markId = (created.json() as { id: string }).id;

    const cleared = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${targetPlayerId}/marks/${markId}`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ clear_reason: 'false positive' }),
    });
    expect(cleared.statusCode).toBe(200);
    const clearedBody = cleared.json() as {
      active: boolean;
      cleared_by: string | null;
      cleared_at: string | null;
      clear_reason: string | null;
    };
    expect(clearedBody.active).toBe(false);
    expect(clearedBody.cleared_by).toBe(h.seed.ownerPlayerId);
    expect(clearedBody.cleared_at).not.toBeNull();
    expect(clearedBody.clear_reason).toBe('false positive');

    const activeOnly = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetPlayerId}/marks?include_cleared=false`,
      headers: { cookie: ownerCookie },
    });
    const activeIds = (activeOnly.json() as { items: Array<{ id: string }> }).items.map(
      (m) => m.id,
    );
    expect(activeIds).not.toContain(markId);

    const withCleared = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetPlayerId}/marks?include_cleared=true`,
      headers: { cookie: ownerCookie },
    });
    const allItems = (withCleared.json() as { items: Array<{ id: string; active: boolean }> })
      .items;
    const clearedItem = allItems.find((m) => m.id === markId);
    expect(clearedItem).toBeDefined();
    expect(clearedItem?.active).toBe(false);
  });

  it('writes a player.mark.clear audit entry with before/after and the actor', async () => {
    const row = await assertAuditRow(h, {
      action: 'player.mark.clear',
      resource: 'player_mark',
    });
    expect(row.actorKind).toBe('steam');
    expect(row.actorPlayerId).toBe(h.seed.ownerPlayerId);
    expect(row.beforeSnapshot).toMatchObject({ active: true });
    expect(row.afterSnapshot).toMatchObject({ active: false });
  });

  it('re-setting a cleared type is allowed (partial unique index only blocks active dupes)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${targetPlayerId}/marks`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 6 }),
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns 409 when clearing an already-cleared mark', async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${eosPlayerId}/marks`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 7 }),
    });
    const markId = (created.json() as { id: string }).id;
    const firstClear = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${eosPlayerId}/marks/${markId}`,
      headers: { cookie: ownerCookie },
    });
    expect(firstClear.statusCode).toBe(200);
    const secondClear = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${eosPlayerId}/marks/${markId}`,
      headers: { cookie: ownerCookie },
    });
    expect(secondClear.statusCode).toBe(409);
    expect(secondClear.json()).toEqual({ error: 'mark_already_cleared' });
  });

  it('returns 404 for an unknown mark id', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${targetPlayerId}/marks/00000000-0000-7000-8000-000000000000`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describeIfDb('audit trail contains both set and clear for the actor', () => {
  it('has at least one set and one clear entry attributed to the owner', async () => {
    const cutoff = new Date(Date.now() - 60_000);
    const setRows = await h.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actionType, 'player.mark.set'),
          eq(auditLog.actorPlayerId, h.seed.ownerPlayerId ?? ''),
          gte(auditLog.createdAt, cutoff),
        ),
      )
      .orderBy(desc(auditLog.createdAt));
    const clearRows = await h.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actionType, 'player.mark.clear'),
          eq(auditLog.actorPlayerId, h.seed.ownerPlayerId ?? ''),
          gte(auditLog.createdAt, cutoff),
        ),
      )
      .orderBy(desc(auditLog.createdAt));
    expect(setRows.length).toBeGreaterThanOrEqual(1);
    expect(clearRows.length).toBeGreaterThanOrEqual(1);
  });
});

describeIfDb('mark.changed live events', () => {
  it('publishes on set and clear with the enriched mark payload', async () => {
    const [live] = await h.db
      .insert(players)
      .values({
        steamId64: testSteamId(810050),
        canonicalName: 'LiveSuspect',
        canonicalNameNormalized: 'livesuspect',
      })
      .returning({ id: players.id });
    if (!live) throw new Error('failed to seed live player');

    const received: LiveEvent[] = [];
    const unsub = h.app.liveBus.subscribe((event) => received.push(event));
    try {
      const created = await h.app.inject({
        method: 'POST',
        url: `/api/v1/players/${live.id}/marks`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ mark_type_id: 8, comment: 'toxic chat' }),
      });
      expect(created.statusCode).toBe(201);
      const markId = (created.json() as { id: string }).id;

      const setEvt = received.find((e) => e.type === 'mark.changed' && e.data.action === 'set');
      expect(setEvt).toBeDefined();
      if (setEvt && setEvt.type === 'mark.changed') {
        expect(setEvt.data.player_id).toBe(live.id);
        expect(setEvt.data.mark.mark_type_id).toBe(8);
        expect(setEvt.data.mark.active).toBe(true);
        expect(setEvt.data.mark.created_by_name).toBe('MarkOwner');
        expect(setEvt.data.mark.mark_type.slug).toBe('toxic');
        expect(setEvt.data.mark.comment).toBe('toxic chat');
      }

      received.length = 0;
      const cleared = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/players/${live.id}/marks/${markId}`,
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ clear_reason: 'resolved' }),
      });
      expect(cleared.statusCode).toBe(200);

      const clrEvt = received.find((e) => e.type === 'mark.changed' && e.data.action === 'cleared');
      expect(clrEvt).toBeDefined();
      if (clrEvt && clrEvt.type === 'mark.changed') {
        expect(clrEvt.data.player_id).toBe(live.id);
        expect(clrEvt.data.mark.active).toBe(false);
        expect(clrEvt.data.mark.cleared_by_name).toBe('MarkOwner');
        expect(clrEvt.data.mark.clear_reason).toBe('resolved');
      }
    } finally {
      unsub();
    }
  });
});

describeIfDb('GET /api/v1/marks/active-summary', () => {
  it('lists only players that currently have at least one active mark', async () => {
    const [clearedOnly] = await h.db
      .insert(players)
      .values({
        steamId64: testSteamId(810051),
        canonicalName: 'ClearedOnly',
        canonicalNameNormalized: 'clearedonly',
      })
      .returning({ id: players.id });
    if (!clearedOnly) throw new Error('failed to seed cleared-only player');

    const created = await h.app.inject({
      method: 'POST',
      url: `/api/v1/players/${clearedOnly.id}/marks`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mark_type_id: 5 }),
    });
    const markId = (created.json() as { id: string }).id;
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/players/${clearedOnly.id}/marks/${markId}`,
      headers: { cookie: ownerCookie },
    });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/marks/active-summary',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const items = (
      res.json() as {
        items: Array<{ player_id: string; marks: Array<{ slug: string; severity: number }> }>;
      }
    ).items;

    const target = items.find((i) => i.player_id === targetPlayerId);
    expect(target).toBeDefined();
    expect(target?.marks.length).toBeGreaterThanOrEqual(1);
    expect(target?.marks[0]).toHaveProperty('slug');
    expect(target?.marks[0]).toHaveProperty('severity');

    expect(items.find((i) => i.player_id === clearedOnly.id)).toBeUndefined();
  });

  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/marks/active-summary' });
    expect(res.statusCode).toBe(401);
  });
});
