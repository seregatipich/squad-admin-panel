import { alertEvents, alertRules, players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(942001);
const EDITOR_STEAM = testSteamId(942002);
const VIEWER_STEAM = testSteamId(942003);

let h: IntegrationHarness;
let ownerCookie: string;
let editorCookie: string;
let viewerCookie: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

async function loginAsSteam(steamId64: bigint, userAgent: string): Promise<string> {
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
    userAgent,
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function seedRoleWithPlayer(opts: {
  roleName: string;
  steamId64: bigint;
  canEditRoles: boolean;
}): Promise<void> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.roleName,
    color: '#3366AA',
    panelAccess: true,
    canEditRoles: opts.canEditRoles,
  });
  const stub = `Player${String(opts.steamId64).slice(-4)}`;
  await h.db.insert(players).values({
    steamId64: opts.steamId64,
    canonicalName: stub,
    canonicalNameNormalized: stub.toLowerCase(),
    roleId,
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  await seedRoleWithPlayer({
    roleName: 'AlertEditor',
    steamId64: EDITOR_STEAM,
    canEditRoles: true,
  });
  await seedRoleWithPlayer({
    roleName: 'AlertViewer',
    steamId64: VIEWER_STEAM,
    canEditRoles: false,
  });
  ownerCookie = await loginAsOwner(h);
  editorCookie = await loginAsSteam(EDITOR_STEAM, 'alerts-editor');
  viewerCookie = await loginAsSteam(VIEWER_STEAM, 'alerts-viewer');
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

async function createRule(
  cookie: string,
  overrides: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/alert-rules',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: `Crash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'server_crashed',
      config: {},
      channels: ['email'],
      enabled: true,
      ...overrides,
    }),
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

describeIfDb('alert-rules RBAC (role:edit for writes)', () => {
  it('rejects unauthenticated create with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/alert-rules',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'nope', type: 'server_crashed' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects create for a panel user without role:edit (403)', async () => {
    const { statusCode } = await createRule(viewerCookie);
    expect(statusCode).toBe(403);
  });

  it('allows an editor with role:edit to create (201)', async () => {
    const { statusCode, body } = await createRule(editorCookie);
    expect(statusCode).toBe(201);
    expect(body.type).toBe('server_crashed');
    expect(body.enabled).toBe(true);
    expect(body.channels).toEqual(['email']);
  });

  it('allows the Owner to create (201)', async () => {
    const { statusCode } = await createRule(ownerCookie);
    expect(statusCode).toBe(201);
  });
});

describeIfDb('alert-rules validation', () => {
  it('rejects a custom rule without an eventKind (400)', async () => {
    const { statusCode } = await createRule(editorCookie, { type: 'custom', config: {} });
    expect(statusCode).toBe(400);
  });

  it('accepts a custom rule with an eventKind', async () => {
    const { statusCode, body } = await createRule(editorCookie, {
      type: 'custom',
      config: { eventKind: 'rcon.disconnected', threshold: 3 },
    });
    expect(statusCode).toBe(201);
    expect(body.type).toBe('custom');
  });

  it('rejects an unusual_activity rule without a positive connectThreshold (400)', async () => {
    const { statusCode } = await createRule(editorCookie, {
      type: 'unusual_activity',
      config: { windowMinutes: 5, connectThreshold: 0 },
    });
    expect(statusCode).toBe(400);
  });
});

describeIfDb('alert-rules update / delete', () => {
  it('updates enabled and channels via PUT', async () => {
    const { body } = await createRule(editorCookie);
    const id = body.id as string;
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/alert-rules/${id}`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false, channels: ['email', 'webpush'] }),
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as Record<string, unknown>;
    expect(updated.enabled).toBe(false);
    expect(updated.channels).toEqual(['email', 'webpush']);
  });

  it('rejects update/delete for a viewer (403)', async () => {
    const { body } = await createRule(editorCookie);
    const id = body.id as string;
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/alert-rules/${id}`,
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(put.statusCode).toBe(403);
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/alert-rules/${id}`,
      headers: { cookie: viewerCookie },
    });
    expect(del.statusCode).toBe(403);
  });

  it('deletes a rule and returns 404 afterwards', async () => {
    const { body } = await createRule(editorCookie);
    const id = body.id as string;
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/alert-rules/${id}`,
      headers: { cookie: editorCookie },
    });
    expect(del.statusCode).toBe(200);
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/alert-rules/${id}`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(put.statusCode).toBe(404);
  });
});

describeIfDb('alert-rules mutations are audited', () => {
  it('writes alert_rule.create / update / delete audit rows', async () => {
    const { body } = await createRule(editorCookie);
    const id = body.id as string;
    await assertAuditRow(h, { action: 'alert_rule.create', resource: 'alert_rule' });

    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/alert-rules/${id}`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    await assertAuditRow(h, { action: 'alert_rule.update', resource: 'alert_rule', targetId: id });

    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/alert-rules/${id}`,
      headers: { cookie: editorCookie },
    });
    await assertAuditRow(h, { action: 'alert_rule.delete', resource: 'alert_rule', targetId: id });
  });
});

describeIfDb('alerts history feed (panel_access)', () => {
  it('rejects unauthenticated read with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/alerts' });
    expect(res.statusCode).toBe(401);
  });

  it('returns recorded alert_events joined with their rule, newest first', async () => {
    const { body } = await createRule(editorCookie, { name: `HistoryRule-${Date.now()}` });
    const ruleId = body.id as string;
    await h.db.insert(alertEvents).values([
      {
        ruleId,
        severity: 'critical',
        delivered: false,
        payload: { eventType: 'server.crashed' },
        triggeredAt: new Date('2026-07-05T09:00:00.000Z'),
      },
      {
        ruleId,
        severity: 'warning',
        delivered: true,
        payload: { eventType: 'player.connected' },
        triggeredAt: new Date('2026-07-05T10:00:00.000Z'),
      },
    ]);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/alerts?rule_id=${ruleId}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const feed = res.json() as Array<Record<string, unknown>>;
    expect(feed).toHaveLength(2);
    expect(feed[0]?.severity).toBe('warning');
    expect(feed[0]?.delivered).toBe(true);
    expect(feed[0]?.rule_name).toContain('HistoryRule-');
    expect(feed[0]?.rule_type).toBe('server_crashed');
  });

  it('lets a panel viewer read the aggregate list of rules', async () => {
    await createRule(editorCookie);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/alert-rules',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
  });
});

describeIfDb('deleting a rule cascades its alert_events', () => {
  it('removes alert_events when the parent rule is deleted', async () => {
    const { body } = await createRule(editorCookie);
    const ruleId = body.id as string;
    await h.db
      .insert(alertEvents)
      .values({ ruleId, severity: 'info', payload: {}, triggeredAt: new Date() });
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/alert-rules/${ruleId}`,
      headers: { cookie: editorCookie },
    });
    const remaining = await h.db
      .select({ id: alertEvents.id })
      .from(alertEvents)
      .where(eq(alertEvents.ruleId, ruleId));
    expect(remaining).toHaveLength(0);
    const rules = await h.db
      .select({ id: alertRules.id })
      .from(alertRules)
      .where(eq(alertRules.id, ruleId));
    expect(rules).toHaveLength(0);
  });
});
