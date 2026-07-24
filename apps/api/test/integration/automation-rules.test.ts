import { automationRules, automationRuns, players, roles, servers } from '@squad/db/schema';
import { rconCommandStream } from '@squad/shared-types';
import { and, eq } from 'drizzle-orm';
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

const OWNER_STEAM = testSteamId(943001);
const EDITOR_STEAM = testSteamId(943002);
const VIEWER_STEAM = testSteamId(943003);

let h: IntegrationHarness;
let ownerCookie: string;
let editorCookie: string;
let viewerCookie: string;
let serverId: string;

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
  await seedRoleWithPlayer({ roleName: 'AutoEditor', steamId64: EDITOR_STEAM, canEditRoles: true });
  await seedRoleWithPlayer({
    roleName: 'AutoViewer',
    steamId64: VIEWER_STEAM,
    canEditRoles: false,
  });
  ownerCookie = await loginAsOwner(h);
  editorCookie = await loginAsSteam(EDITOR_STEAM, 'auto-editor');
  viewerCookie = await loginAsSteam(VIEWER_STEAM, 'auto-viewer');

  serverId = uuidv7();
  await h.db.insert(servers).values({
    id: serverId,
    displayName: 'Auto Server',
    slug: `auto-server-${serverId}`,
  });
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
    url: '/api/v1/automation-rules',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: `Rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      server_id: serverId,
      condition_type: 'chat_keyword',
      condition: { keyword: 'hello' },
      action_type: 'warn',
      action: { message: 'no greetings' },
      enabled: true,
      ...overrides,
    }),
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

describeIfDb('automation-rules RBAC (role:edit for writes)', () => {
  it('rejects unauthenticated create with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/automation-rules',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'nope',
        condition_type: 'chat_keyword',
        condition: { keyword: 'x' },
        action_type: 'warn',
        action: { message: 'y' },
      }),
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
    expect(body.condition_type).toBe('chat_keyword');
    expect(body.action_type).toBe('warn');
    expect(body.enabled).toBe(true);
  });

  it('allows the Owner to create (201)', async () => {
    const { statusCode } = await createRule(ownerCookie);
    expect(statusCode).toBe(201);
  });
});

describeIfDb('automation-rules validation', () => {
  it('rejects a player_count condition without a threshold (400)', async () => {
    const { statusCode } = await createRule(editorCookie, {
      condition_type: 'player_count',
      condition: { operator: 'gte' },
      action_type: 'notify_admin',
      action: { message: 'seeding' },
    });
    expect(statusCode).toBe(400);
  });

  it('rejects an rcon_command action with an unknown command (400)', async () => {
    const { statusCode } = await createRule(editorCookie, {
      condition_type: 'player_count',
      condition: { operator: 'gte', threshold: 60 },
      action_type: 'rcon_command',
      action: { command: 'NotARealCommand' },
    });
    expect(statusCode).toBe(400);
  });

  it('accepts a valid player_count → rcon_command rule', async () => {
    const { statusCode, body } = await createRule(editorCookie, {
      condition_type: 'player_count',
      condition: { operator: 'gte', threshold: 60 },
      action_type: 'rcon_command',
      action: { command: 'AdminBroadcast', args: ['full server'] },
    });
    expect(statusCode).toBe(201);
    expect(body.action_type).toBe('rcon_command');
  });
});

describeIfDb('automation-rules update / delete', () => {
  it('updates enabled and condition via PUT', async () => {
    const { body } = await createRule(editorCookie);
    const id = body.id as string;
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/automation-rules/${id}`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false, condition: { keyword: 'goodbye' } }),
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as Record<string, unknown>;
    expect(updated.enabled).toBe(false);
    expect(updated.condition).toEqual({ keyword: 'goodbye' });
  });

  it('rejects an update whose new condition is invalid for the type (400)', async () => {
    const { body } = await createRule(editorCookie, {
      condition_type: 'player_count',
      condition: { operator: 'gte', threshold: 40 },
      action_type: 'notify_admin',
      action: { message: 'x' },
    });
    const id = body.id as string;
    const res = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/automation-rules/${id}`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ condition: { operator: 'gte' } }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects update/delete for a viewer (403)', async () => {
    const { body } = await createRule(editorCookie);
    const id = body.id as string;
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/automation-rules/${id}`,
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(put.statusCode).toBe(403);
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/automation-rules/${id}`,
      headers: { cookie: viewerCookie },
    });
    expect(del.statusCode).toBe(403);
  });

  it('deletes a rule and returns 404 afterwards', async () => {
    const { body } = await createRule(editorCookie);
    const id = body.id as string;
    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/automation-rules/${id}`,
      headers: { cookie: editorCookie },
    });
    expect(del.statusCode).toBe(200);
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/automation-rules/${id}`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(put.statusCode).toBe(404);
  });
});

describeIfDb('automation-rules dry-run (never executes the action)', () => {
  it('a matching dry-run records a dry_run row but enqueues NO RCON command', async () => {
    const { body } = await createRule(editorCookie, { action: { message: 'no greetings' } });
    const id = body.id as string;

    const streamKey = rconCommandStream(serverId);
    const before = await h.redis.xlen(streamKey);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/automation-rules/${id}/dry-run`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        sample: {
          chat_message: 'well hello there',
          player: { steam_id64: '76561190000000001', name: 'Tester' },
        },
      }),
    });
    expect(res.statusCode).toBe(200);
    const outcome = res.json() as { matched: boolean; runs: Array<{ status: string }> };
    expect(outcome.matched).toBe(true);
    expect(outcome.runs[0]?.status).toBe('matched');

    // Load-bearing assertion: the action was evaluated but NOT executed —
    // no RCON command was enqueued onto worker-rcon's stream.
    const after = await h.redis.xlen(streamKey);
    expect(after).toBe(before);

    // …and a firing-history row was persisted with dry_run = true.
    const runs = await h.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.ruleId, id), eq(automationRuns.dryRun, true)));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.every((r) => r.dryRun === true)).toBe(true);
    expect(runs.some((r) => r.status === 'matched')).toBe(true);
  });

  it('a non-matching dry-run records a no_match dry_run row', async () => {
    const { body } = await createRule(editorCookie, { condition: { keyword: 'zzz-unlikely' } });
    const id = body.id as string;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/automation-rules/${id}/dry-run`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ sample: { chat_message: 'nothing to see' } }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { matched: boolean }).matched).toBe(false);
    const runs = await h.db
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.ruleId, id), eq(automationRuns.status, 'no_match')));
    expect(runs.length).toBe(1);
    expect(runs[0]?.dryRun).toBe(true);
  });

  it('rejects dry-run for a viewer (403)', async () => {
    const { body } = await createRule(editorCookie);
    const id = body.id as string;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/automation-rules/${id}/dry-run`,
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ sample: { chat_message: 'hello' } }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describeIfDb('automation-rules mutations and runs are audited', () => {
  it('writes create / update / delete / dry_run audit rows', async () => {
    const { body } = await createRule(editorCookie);
    const id = body.id as string;
    await assertAuditRow(h, { action: 'automation_rule.create', resource: 'automation_rule' });

    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/automation-rules/${id}`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    await assertAuditRow(h, {
      action: 'automation_rule.update',
      resource: 'automation_rule',
      targetId: id,
    });

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/automation-rules/${id}/dry-run`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ sample: { chat_message: 'hello' } }),
    });
    await assertAuditRow(h, {
      action: 'automation_rule.dry_run',
      resource: 'automation_rule',
      targetId: id,
    });

    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/automation-rules/${id}`,
      headers: { cookie: editorCookie },
    });
    await assertAuditRow(h, {
      action: 'automation_rule.delete',
      resource: 'automation_rule',
      targetId: id,
    });
  });
});

describeIfDb('automation runs history feed (panel_access)', () => {
  it('rejects unauthenticated read with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/automation-runs' });
    expect(res.statusCode).toBe(401);
  });

  it('returns dry-run history rows joined with their rule, newest first', async () => {
    const { body } = await createRule(editorCookie, { name: `HistoryRule-${Date.now()}` });
    const ruleId = body.id as string;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/automation-rules/${ruleId}/dry-run`,
      headers: { cookie: editorCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        sample: { chat_message: 'hello', player: { steam_id64: '76561190000000009' } },
      }),
    });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/automation-runs?rule_id=${ruleId}`,
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const feed = res.json() as Array<Record<string, unknown>>;
    expect(feed.length).toBeGreaterThanOrEqual(1);
    expect(feed[0]?.rule_id).toBe(ruleId);
    expect(feed[0]?.dry_run).toBe(true);
    expect(feed[0]?.rule_name).toContain('HistoryRule-');
    expect(feed[0]?.condition_type).toBe('chat_keyword');
  });

  it('lets a panel viewer read the aggregate list of rules', async () => {
    await createRule(editorCookie);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/automation-rules',
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBeGreaterThan(0);
  });
});

describeIfDb('deleting a rule cascades its runs', () => {
  it('removes automation_runs when the parent rule is deleted', async () => {
    const { body } = await createRule(editorCookie);
    const ruleId = body.id as string;
    await h.db.insert(automationRuns).values({
      ruleId,
      serverId,
      matched: {},
      status: 'executed',
      dryRun: false,
    });
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/automation-rules/${ruleId}`,
      headers: { cookie: editorCookie },
    });
    const remaining = await h.db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(eq(automationRuns.ruleId, ruleId));
    expect(remaining).toHaveLength(0);
    const rows = await h.db
      .select({ id: automationRules.id })
      .from(automationRules)
      .where(eq(automationRules.id, ruleId));
    expect(rows).toHaveLength(0);
  });
});
