import {
  auditLog,
  moderationActions,
  playerReports,
  players,
  roles,
  servers,
} from '@squad/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import type { WorkerRconCommandOutcome } from '../../src/lib/rcon-worker-command.js';
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

vi.mock('../../src/lib/rcon-worker-command.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rcon-worker-command.js')>()),
  sendRconCommandViaWorker: vi.fn(),
}));

import { sendRconCommandViaWorker } from '../../src/lib/rcon-worker-command.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM = testSteamId(951000);
const HANDLER_STEAM = testSteamId(951001);
const PANEL_ONLY_STEAM = testSteamId(951002);
const NO_PANEL_STEAM = testSteamId(951003);
const REPORTER_STEAM = testSteamId(951011);
const TARGET_STEAM = testSteamId(951012);
const REPORTER_STEAM_B = testSteamId(951013);
const TARGET_STEAM_B = testSteamId(951014);
const OTHER_TARGET_STEAM = testSteamId(951015);

let h: IntegrationHarness;
let serverId: string;
let reporterId: string;
let targetId: string;

function okOutcome(overrides: Partial<WorkerRconCommandOutcome> = {}): WorkerRconCommandOutcome {
  return {
    attempted: true,
    ok: true,
    requestId: 'req-test',
    response: 'ok',
    via: 'worker-rcon',
    ...overrides,
  } as WorkerRconCommandOutcome;
}

function notConnectedOutcome(): WorkerRconCommandOutcome {
  return { attempted: false, reason: 'worker_not_connected' };
}

function storedRoster(serverIdValue: string, playerEntries: Array<Record<string, unknown>>) {
  return JSON.stringify({
    server_id: serverIdValue,
    polled_at: '2026-07-09T10:00:00.000Z',
    players: playerEntries,
  });
}

function rosterEntry(overrides: Record<string, unknown>) {
  return {
    rcon_id: 0,
    eos_id: 'eos-000000000000000000000000000001',
    steam_id64: '76561198000000001',
    name: 'Player',
    team_id: 1,
    squad_id: 1,
    is_leader: false,
    role: null,
    first_seen_at: '2026-07-09T09:55:00.000Z',
    ...overrides,
  };
}

async function seedPlayer(steamId64: bigint, name: string, eosId: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      eosId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player ${name}`);
  return row.id;
}

async function seedRoleWithPlayer(opts: {
  roleName: string;
  steamId64: bigint;
  panelAccess: boolean;
  canHandleReports: boolean;
}): Promise<string> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.roleName,
    color: '#3366AA',
    panelAccess: opts.panelAccess,
    canHandleReports: opts.canHandleReports,
  });
  const stub = `RA${String(opts.steamId64).slice(-6)}`;
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: opts.steamId64,
      canonicalName: stub,
      canonicalNameNormalized: stub.toLowerCase(),
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed player for ${opts.roleName}`);
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
    userAgent: 'report-actions-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function insertReport(
  overrides: Partial<typeof playerReports.$inferInsert> = {},
): Promise<string> {
  const [row] = await h.db
    .insert(playerReports)
    .values({
      serverId,
      reporterPlayerId: reporterId,
      targetPlayerId: targetId,
      body: 'Cheating on the server',
      source: 'ingame',
      status: 'pending',
      ...overrides,
    })
    .returning({ id: playerReports.id });
  if (!row) throw new Error('failed to seed report');
  return row.id;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });

  await seedRoleWithPlayer({
    roleName: `ReportActionsHandler-${uuidv7()}`,
    steamId64: HANDLER_STEAM,
    panelAccess: true,
    canHandleReports: true,
  });
  await seedRoleWithPlayer({
    roleName: `ReportActionsPanelOnly-${uuidv7()}`,
    steamId64: PANEL_ONLY_STEAM,
    panelAccess: true,
    canHandleReports: false,
  });
  await seedRoleWithPlayer({
    roleName: `ReportActionsNoPanel-${uuidv7()}`,
    steamId64: NO_PANEL_STEAM,
    panelAccess: false,
    canHandleReports: false,
  });

  serverId = uuidv7();
  await h.db
    .insert(servers)
    .values({ id: serverId, displayName: 'RA Test Server', slug: `ra-test-${serverId}` });

  reporterId = await seedPlayer(REPORTER_STEAM, 'Reporter', 'eos-reporter');
  targetId = await seedPlayer(TARGET_STEAM, 'Target', 'eos-target');
});

beforeEach(() => {
  vi.mocked(sendRconCommandViaWorker).mockReset();
});

afterEach(async () => {
  invalidateAllPermissionCaches();
  // Every case files its reports against the same reporter/target pair, and
  // bulk-resolve acts on all of that target's open reports: drop this case's
  // reports, their ledger rows and the published roster.
  await h.db.delete(moderationActions);
  await h.db.delete(playerReports);
  await h.redis.del(`rcon:roster:${serverId}`);
});

afterAll(async () => {
  await h?.cleanup();
});

describeIfDb('POST /api/v1/reports/:id/actions', () => {
  it('rejects unauthenticated requests', async () => {
    const reportId = await insertReport();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/actions`,
      payload: { action_type: 'warn', reason: 'stop it' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a panel user without can_handle_reports', async () => {
    const reportId = await insertReport();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: { cookie: await loginAsSteam(PANEL_ONLY_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ action_type: 'warn', reason: 'stop it' }),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { required: string }).required).toBe('can_handle_reports');
  });

  it('400s when the report has no resolved target', async () => {
    const reportId = await insertReport({ targetPlayerId: null, targetRaw: 'UnknownGuy' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ action_type: 'warn', reason: 'stop it' }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('report_target_unresolved');
  });

  it('409s with target_offline for warn/kick when the target is not on the live roster', async () => {
    await h.redis.set(`rcon:roster:${serverId}`, storedRoster(serverId, []));
    const reportId = await insertReport();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ action_type: 'kick', reason: 'stop it' }),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('target_offline');
    expect(sendRconCommandViaWorker).not.toHaveBeenCalled();
    const rows = await h.db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.reportId, reportId));
    expect(rows).toHaveLength(0);
  });

  it('warns an online target, links the moderation_actions row to the report, and it appears in both moderation history and the report action list', async () => {
    await h.redis.set(
      `rcon:roster:${serverId}`,
      storedRoster(serverId, [
        rosterEntry({ eos_id: 'eos-target', steam_id64: String(TARGET_STEAM) }),
      ]),
    );
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
    const reportId = await insertReport();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ action_type: 'warn', reason: 'Stop teamkilling' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { action_type: string; report_id: string; reason: string };
    expect(body.action_type).toBe('warn');
    expect(body.report_id).toBe(reportId);
    expect(body.reason).toBe('Stop teamkilling');

    expect(sendRconCommandViaWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: 'AdminWarn', args: ['eos-target', 'Stop teamkilling'] }),
    );

    const inLedger = await h.db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.reportId, reportId));
    expect(inLedger).toHaveLength(1);
    expect(inLedger[0]).toMatchObject({ playerId: targetId, actionType: 'warn', reportId });

    const historyRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${targetId}/moderation-actions`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(historyRes.statusCode).toBe(200);
    const historyBody = historyRes.json() as { actions: Array<{ report_id: string | null }> };
    expect(historyBody.actions.some((a) => a.report_id === reportId)).toBe(true);

    const linkedRes = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(linkedRes.statusCode).toBe(200);
    const linkedBody = linkedRes.json() as { actions: Array<{ action_type: string }> };
    expect(linkedBody.actions).toHaveLength(1);
    expect(linkedBody.actions[0]?.action_type).toBe('warn');
  });

  it('bans a target that is offline, sending AdminBan with the ban length and reason', async () => {
    await h.redis.set(`rcon:roster:${serverId}`, storedRoster(serverId, []));
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
    const reportId = await insertReport();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ action_type: 'ban', reason: 'Cheating', ban_length: '0' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { action_type: string };
    expect(body.action_type).toBe('ban');

    expect(sendRconCommandViaWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: 'AdminBan', args: ['eos-target', '0', 'Cheating'] }),
    );

    const rows = await h.db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.reportId, reportId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actionType: 'ban', playerId: targetId });
  });

  it('502s and writes no ledger row when the RCON worker is unavailable', async () => {
    await h.redis.set(
      `rcon:roster:${serverId}`,
      storedRoster(serverId, [
        rosterEntry({ eos_id: 'eos-target', steam_id64: String(TARGET_STEAM) }),
      ]),
    );
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(notConnectedOutcome());
    const reportId = await insertReport();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ action_type: 'warn', reason: 'stop it' }),
    });
    expect(res.statusCode).toBe(502);
    const rows = await h.db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.reportId, reportId));
    expect(rows).toHaveLength(0);
  });

  it('writes a report.action audit entry', async () => {
    await h.redis.set(
      `rcon:roster:${serverId}`,
      storedRoster(serverId, [
        rosterEntry({ eos_id: 'eos-target', steam_id64: String(TARGET_STEAM) }),
      ]),
    );
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
    const reportId = await insertReport();

    await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ action_type: 'kick', reason: 'stop it' }),
    });

    await assertAuditRow(h, { action: 'report.action', resource: 'report', targetId: reportId });
  });
});

describeIfDb('GET /api/v1/reports/:id/actions', () => {
  it('rejects unauthenticated requests', async () => {
    const reportId = await insertReport();
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/reports/${reportId}/actions` });
    expect(res.statusCode).toBe(401);
  });

  it('is readable with plain panel_access, without can_handle_reports', async () => {
    const reportId = await insertReport();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: { cookie: await loginAsSteam(PANEL_ONLY_STEAM) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('404s for an unknown report', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/reports/00000000-0000-0000-0000-000000000000/actions',
      headers: { cookie: await loginAsOwner(h) },
    });
    expect(res.statusCode).toBe(404);
  });
});

describeIfDb('POST /api/v1/reports/:id/notify-reporter', () => {
  it('rejects unauthenticated requests', async () => {
    const reportId = await insertReport();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/notify-reporter`,
      payload: { template: 'in_review' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a panel user without can_handle_reports', async () => {
    const reportId = await insertReport();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/notify-reporter`,
      headers: { cookie: await loginAsSteam(PANEL_ONLY_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ template: 'in_review' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('sends the AdminWarn template when the reporter is online', async () => {
    await h.redis.set(
      `rcon:roster:${serverId}`,
      storedRoster(serverId, [
        rosterEntry({ eos_id: 'eos-reporter', steam_id64: String(REPORTER_STEAM) }),
      ]),
    );
    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
    const reportId = await insertReport();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/notify-reporter`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ template: 'in_review' }),
    });
    expect(res.statusCode).toBe(200);
    expect(sendRconCommandViaWorker).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        command: 'AdminWarn',
        args: ['eos-reporter', 'Ваш репорт принят в работу модерацией.'],
      }),
    );
    await assertAuditRow(h, {
      action: 'report.notify_reporter',
      resource: 'report',
      targetId: reportId,
    });
  });

  it('409s when the reporter is offline', async () => {
    await h.redis.set(`rcon:roster:${serverId}`, storedRoster(serverId, []));
    const reportId = await insertReport();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/notify-reporter`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ template: 'in_review' }),
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('reporter_offline');
  });

  it('400s when the report has no resolved reporter', async () => {
    const reportId = await insertReport({ reporterPlayerId: null });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/notify-reporter`,
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({ template: 'resolved' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describeIfDb('POST /api/v1/reports/bulk-resolve', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports/bulk-resolve',
      payload: { target_player_id: targetId, status: 'resolved', resolution_note: 'done' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a panel user without can_handle_reports', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports/bulk-resolve',
      headers: { cookie: await loginAsSteam(PANEL_ONLY_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({
        target_player_id: targetId,
        status: 'resolved',
        resolution_note: 'done',
      }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('400s without a resolution_note', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports/bulk-resolve',
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({
        target_player_id: targetId,
        status: 'resolved',
        resolution_note: '',
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s when the target has no pending/in_review reports', async () => {
    const otherTargetId = await seedPlayer(OTHER_TARGET_STEAM, 'NoReportsTarget', 'eos-no-reports');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reports/bulk-resolve',
      headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
      payload: JSON.stringify({
        target_player_id: otherTargetId,
        status: 'resolved',
        resolution_note: 'done',
      }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('resolves every pending/in_review report on the target, leaves other targets untouched, and writes one audit row per report sharing a bulk_group', async () => {
    const reporterB = await seedPlayer(REPORTER_STEAM_B, 'ReporterB', 'eos-reporter-b');
    const targetB = await seedPlayer(TARGET_STEAM_B, 'TargetB', 'eos-target-b');

    const idA1 = await insertReport({ status: 'pending' });
    const idA2 = await insertReport({ status: 'in_review' });
    const idA3 = await insertReport({ status: 'pending' });
    const idAResolved = await insertReport({ status: 'resolved' });
    const idB = await insertReport({
      reporterPlayerId: reporterB,
      targetPlayerId: targetB,
      status: 'pending',
    });

    const received: LiveEvent[] = [];
    const unsub = h.app.liveBus.subscribe((event) => received.push(event));
    let res: Awaited<ReturnType<typeof h.app.inject>>;
    try {
      res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/reports/bulk-resolve',
        headers: { cookie: await loginAsSteam(HANDLER_STEAM), 'content-type': 'application/json' },
        payload: JSON.stringify({
          target_player_id: targetId,
          status: 'resolved',
          resolution_note: 'Reviewed as a group',
        }),
      });
    } finally {
      unsub();
    }

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; resolved_ids: string[] };
    expect(body.resolved_ids.sort()).toEqual([idA1, idA2, idA3].sort());

    const resolvedRows = await h.db
      .select()
      .from(playerReports)
      .where(inArray(playerReports.id, [idA1, idA2, idA3]));
    for (const row of resolvedRows) {
      expect(row.status).toBe('resolved');
      expect(row.resolutionNote).toBe('Reviewed as a group');
      expect(row.resolvedAt).not.toBeNull();
    }

    const untouched = await h.db
      .select()
      .from(playerReports)
      .where(eq(playerReports.id, idAResolved));
    expect(untouched[0]?.resolutionNote).toBeNull();

    const untouchedB = await h.db.select().from(playerReports).where(eq(playerReports.id, idB));
    expect(untouchedB[0]?.status).toBe('pending');

    const auditRows = await h.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actionType, 'report.update'),
          inArray(auditLog.targetId, [idA1, idA2, idA3]),
        ),
      );
    expect(auditRows).toHaveLength(3);
    const bulkGroups = new Set(
      auditRows.map((row) => (row.context as Record<string, unknown>).bulk_group),
    );
    expect(bulkGroups.size).toBe(1);

    const updatedEvents = received.filter(
      (e) => e.type === 'report.updated' && [idA1, idA2, idA3].includes(e.data.report.id),
    );
    expect(updatedEvents).toHaveLength(3);
  });
});
