import {
  players,
  roleSquadPermissions,
  roles,
  scheduledTaskRuns,
  scheduledTasks,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM_ID = testSteamId(173000);

// A layer known to the ROT-1 fallback catalog (migration 0042).
const CATALOG_LAYER = 'Yehorivka RAAS v11';

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  if (h.seed.ownerPlayerId) invalidatePermissionCache(h.seed.ownerPlayerId);
  await h.cleanup();
});

async function login(): Promise<string> {
  return loginAsOwner(h);
}

async function createServer(cookie: string, slug = 'scheduled-tasks-server'): Promise<string> {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/servers',
    headers: { cookie },
    payload: {
      display_name: 'Scheduled Tasks Server',
      slug,
      game_port: 7787,
      query_port: 27165,
      beacon_port: 15000,
      rcon_port: 21114,
      max_players: 80,
      tickrate: 50,
      multihome: '0.0.0.0',
    },
  });
  if (resp.statusCode !== 201) throw new Error(`server create failed: ${resp.body}`);
  return resp.json<{ id: string }>().id;
}

/** Demotes the seeded owner to a role with the given panel access + squad permissions. */
async function asRole(opts: {
  panelAccess?: boolean;
  squadPermissions?: string[];
}): Promise<string> {
  const roleId = uuidv7();
  await h.db.transaction(async (tx) => {
    await tx.insert(roles).values({
      id: roleId,
      name: `Sched-${roleId.slice(0, 8)}`,
      color: 'blue',
      isSystemRole: false,
      panelAccess: opts.panelAccess ?? true,
    });
    for (const key of opts.squadPermissions ?? []) {
      await tx.insert(roleSquadPermissions).values({ roleId, squadPermissionKey: key });
    }
  });
  await h.db
    .update(players)
    .set({ roleId })
    // biome-ignore lint/style/noNonNullAssertion: owner steam id seeded above
    .where(eq(players.steamId64, h.seed.ownerSteamId64!));
  // biome-ignore lint/style/noNonNullAssertion: owner player seeded above
  invalidatePermissionCache(h.seed.ownerPlayerId!);
  return loginAsOwner(h);
}

interface TaskOut {
  id: string;
  name: string;
  task_type: string;
  params: Record<string, unknown>;
  scheduled_at: string | null;
  recurrence: string | null;
  enabled: boolean;
}

describe('GET /api/v1/servers/:id/scheduled-tasks', () => {
  it('returns 401 without a session cookie', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for an unknown server id', async () => {
    const cookie = await login();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers/019f46a1-0000-7000-8000-000000000000/scheduled-tasks',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns tasks and per-type capabilities for the owner', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      tasks: unknown[];
      capabilities: { restart: boolean; change_layer: boolean; broadcast: boolean };
    }>();
    expect(body.tasks).toEqual([]);
    expect(body.capabilities).toEqual({
      restart: true,
      set_next_layer: true,
      change_layer: true,
      broadcast: true,
    });
  });
});

describe('POST /api/v1/servers/:id/scheduled-tasks', () => {
  it('creates a one-off restart task, persists it, and writes an audit row', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: { name: 'Nightly restart', task_type: 'restart', scheduled_at: scheduledAt },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<TaskOut>();
    expect(body.task_type).toBe('restart');
    expect(body.scheduled_at).toBe(scheduledAt);
    expect(body.recurrence).toBeNull();

    const listRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
    });
    expect(listRes.json<{ tasks: { id: string }[] }>().tasks.map((t) => t.id)).toContain(body.id);

    await assertAuditRow(h, {
      action: 'server.scheduled_task.create',
      resource: 'scheduled_task',
      targetId: body.id,
    });
  });

  it('creates a recurring change_layer task with a valid cron and a catalog layer', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'Weekly layer',
        task_type: 'change_layer',
        params: { layer: CATALOG_LAYER },
        recurrence: '0 10 * * 6',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<TaskOut>();
    expect(body.recurrence).toBe('0 10 * * 6');
    expect(body.params).toEqual({ layer: CATALOG_LAYER });
  });

  it('creates a broadcast task', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'Hourly notice',
        task_type: 'broadcast',
        params: { message: 'Restart in 10 minutes' },
        recurrence: '0 * * * *',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<TaskOut>().params).toEqual({ message: 'Restart in 10 minutes' });
  });

  it('rejects a task with neither scheduled_at nor recurrence', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: { name: 'No schedule', task_type: 'restart' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'missing_schedule' });
  });

  it('rejects an invalid cron recurrence', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: { name: 'Bad cron', task_type: 'restart', recurrence: 'not a cron' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_recurrence' });
  });

  it('rejects a layer task missing its layer param', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'No layer',
        task_type: 'set_next_layer',
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_params' });
  });

  it('rejects a layer task whose layer is not in the catalog', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'Unknown layer',
        task_type: 'change_layer',
        params: { layer: 'Definitely Not A Layer v9' },
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'unknown_layer' });
  });

  it('rejects a broadcast task missing its message param', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'No message',
        task_type: 'broadcast',
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_params' });
  });

  it('returns 403 for a layer task without the changemap squad permission', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    const cookie = await asRole({ panelAccess: true, squadPermissions: ['chat'] });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'Layer',
        task_type: 'change_layer',
        params: { layer: CATALOG_LAYER },
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', required_squad_permission: 'changemap' });
  });

  it('returns 403 for a broadcast task without the chat squad permission', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    const cookie = await asRole({ panelAccess: true, squadPermissions: ['changemap'] });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'Broadcast',
        task_type: 'broadcast',
        params: { message: 'hi' },
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden', required_squad_permission: 'chat' });
  });

  it('returns 403 for a restart task without the server:restart permission', async () => {
    const ownerCookie = await login();
    const serverId = await createServer(ownerCookie);
    const cookie = await asRole({ panelAccess: false, squadPermissions: [] });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'Restart',
        task_type: 'restart',
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden', required_permission: 'server:restart' });
  });
});

describe('PATCH /api/v1/servers/:id/scheduled-tasks/:taskId', () => {
  async function createTask(cookie: string, serverId: string): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'Restart',
        task_type: 'restart',
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    return res.json<{ id: string }>().id;
  }

  it('toggles enabled and writes an audit row', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const taskId = await createTask(cookie, serverId);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}/scheduled-tasks/${taskId}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<TaskOut>().enabled).toBe(false);

    await assertAuditRow(h, {
      action: 'server.scheduled_task.update',
      resource: 'scheduled_task',
      targetId: taskId,
    });
  });

  it('returns 404 for an unknown task id', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/servers/${serverId}/scheduled-tasks/019f46a1-0000-7000-8000-000000000000`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/servers/:id/scheduled-tasks/:taskId', () => {
  it('deletes the task and writes an audit row', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const createRes = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'Restart',
        task_type: 'restart',
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const taskId = createRes.json<{ id: string }>().id;

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/scheduled-tasks/${taskId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true, id: taskId });

    await assertAuditRow(h, {
      action: 'server.scheduled_task.delete',
      resource: 'scheduled_task',
      targetId: taskId,
    });
  });
});

describe('GET /api/v1/servers/:id/scheduled-tasks/history', () => {
  it('returns 401 without a session cookie', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/scheduled-tasks/history`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns execution-history runs newest-first for the server', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const createRes = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'Restart',
        task_type: 'restart',
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const taskId = createRes.json<{ id: string }>().id;

    await h.db.insert(scheduledTaskRuns).values([
      {
        taskId,
        executedAt: new Date('2026-07-01T10:00:00.000Z'),
        status: 'executed',
        detail: { command: 'restart' },
      },
      {
        taskId,
        executedAt: new Date('2026-07-02T10:00:00.000Z'),
        status: 'skipped_depot_update',
        detail: {},
      },
    ]);

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/servers/${serverId}/scheduled-tasks/history`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      runs: { task_id: string; status: string; executed_at: string }[];
    }>();
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]?.status).toBe('skipped_depot_update');
    expect(body.runs[1]?.status).toBe('executed');
    expect(body.runs.every((r) => r.task_id === taskId)).toBe(true);
  });
});

describe('scheduled_tasks cascade', () => {
  it('removes run history when the task is deleted', async () => {
    const cookie = await login();
    const serverId = await createServer(cookie);
    const createRes = await h.app.inject({
      method: 'POST',
      url: `/api/v1/servers/${serverId}/scheduled-tasks`,
      headers: { cookie },
      payload: {
        name: 'Restart',
        task_type: 'restart',
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const taskId = createRes.json<{ id: string }>().id;
    await h.db
      .insert(scheduledTaskRuns)
      .values({ taskId, executedAt: new Date(), status: 'executed', detail: {} });

    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/servers/${serverId}/scheduled-tasks/${taskId}`,
      headers: { cookie },
    });

    const remaining = await h.db
      .select()
      .from(scheduledTaskRuns)
      .where(eq(scheduledTaskRuns.taskId, taskId));
    expect(remaining).toHaveLength(0);
    const remainingTasks = await h.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, taskId));
    expect(remainingTasks).toHaveLength(0);
  });
});
