import {
  alertEvents,
  alertRules,
  moderationActions,
  playerReports,
  players,
  reporterStats,
  roles,
  servers,
} from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import type { WorkerRconCommandOutcome } from '../../src/lib/rcon-worker-command.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, makeFakeBridge } from './harness.js';

vi.mock('../../src/lib/rcon-worker-command.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/rcon-worker-command.js')>()),
  sendRconCommandViaWorker: vi.fn(),
}));

import { sendRconCommandViaWorker } from '../../src/lib/rcon-worker-command.js';

function okOutcome(): WorkerRconCommandOutcome {
  return {
    attempted: true,
    ok: true,
    requestId: 'req-test',
    response: 'ok',
    via: 'worker-rcon',
  } as WorkerRconCommandOutcome;
}

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const OWNER_STEAM = testSteamId(954000);
const HANDLER_STEAM = testSteamId(954001);
const PANEL_ONLY_STEAM = testSteamId(954002);
const REPORTER_A_STEAM = testSteamId(954011);
const REPORTER_SPAM_STEAM = testSteamId(954012);
const TARGET_A_STEAM = testSteamId(954021);
const TARGET_B_STEAM = testSteamId(954022);

let h: IntegrationHarness;
let serverAId: string;
let serverBId: string;
let handlerId: string;
let reporterAId: string;
let reporterSpamId: string;
let targetAId: string;
let targetBId: string;

async function seedPlayer(steamId64: bigint, name: string): Promise<string> {
  const [row] = await h.db
    .insert(players)
    .values({ steamId64, canonicalName: name, canonicalNameNormalized: name.toLowerCase() })
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
  const stub = `RN${String(opts.steamId64).slice(-6)}`;
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
  if (!row) throw new Error(`No player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'report-analytics-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

interface ReportSeed {
  id?: string;
  serverId: string;
  reporterPlayerId: string | null;
  targetPlayerId: string | null;
  status: 'pending' | 'in_review' | 'resolved' | 'rejected';
  createdAt: Date;
  resolvedAt?: Date | null;
  handlerPlayerId?: string | null;
}

async function seedReport(seed: ReportSeed): Promise<string> {
  const id = seed.id ?? uuidv7();
  await h.db.insert(playerReports).values({
    id,
    serverId: seed.serverId,
    reporterPlayerId: seed.reporterPlayerId,
    targetPlayerId: seed.targetPlayerId,
    body: 'Test report body',
    source: 'ingame',
    status: seed.status,
    createdAt: seed.createdAt,
    resolvedAt: seed.resolvedAt ?? null,
    handlerPlayerId: seed.handlerPlayerId ?? null,
  });
  return id;
}

function fetchAnalytics(query: string, cookie: string) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/analytics/reports${query}`,
    headers: { cookie },
  });
}

let ownerCookie: string;
const createdAlertRuleIds: string[] = [];

// One app + database per file; the players, roles and servers are seeded once.
// The analytics aggregate over every report, so each test starts with no
// reports, reporter stats or moderation actions, and drops the alert rule it
// created (the migration-seeded rules stay).
beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsSteam(OWNER_STEAM);

  await seedRoleWithPlayer({
    roleName: `RA-Handler-${uuidv7()}`,
    steamId64: HANDLER_STEAM,
    panelAccess: true,
    canHandleReports: true,
  });
  await seedRoleWithPlayer({
    roleName: `RA-PanelOnly-${uuidv7()}`,
    steamId64: PANEL_ONLY_STEAM,
    panelAccess: true,
    canHandleReports: false,
  });
  handlerId = (
    await h.db.select({ id: players.id }).from(players).where(eq(players.steamId64, HANDLER_STEAM))
  )[0]?.id as string;

  serverAId = uuidv7();
  serverBId = uuidv7();
  await h.db.insert(servers).values([
    { id: serverAId, displayName: 'RA Server A', slug: `ra-a-${serverAId}` },
    { id: serverBId, displayName: 'RA Server B', slug: `ra-b-${serverBId}` },
  ]);

  reporterAId = await seedPlayer(REPORTER_A_STEAM, 'ReporterA');
  reporterSpamId = await seedPlayer(REPORTER_SPAM_STEAM, 'ReporterSpam');
  targetAId = await seedPlayer(TARGET_A_STEAM, 'TargetA');
  targetBId = await seedPlayer(TARGET_B_STEAM, 'TargetB');
});

afterAll(async () => {
  await h?.cleanup();
});

beforeEach(async () => {
  vi.mocked(sendRconCommandViaWorker).mockReset();
  await h.db.delete(moderationActions);
  await h.db.delete(playerReports);
  await h.db.delete(reporterStats);
  for (const id of createdAlertRuleIds.splice(0)) {
    await h.db.delete(alertRules).where(eq(alertRules.id, id));
  }
  invalidateAllPermissionCaches();
});

describeIfDb('GET /api/v1/analytics/reports', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/analytics/reports' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a panel user without can_handle_reports', async () => {
    const res = await fetchAnalytics('', await loginAsSteam(PANEL_ONLY_STEAM));
    expect(res.statusCode).toBe(403);
  });

  it('computes exact by_status counts, avg/median resolution seconds, and trend buckets against a control sample', async () => {
    const day = new Date('2026-06-10T12:00:00.000Z');
    const from = new Date('2026-06-01T00:00:00.000Z').toISOString();
    const to = new Date('2026-06-20T00:00:00.000Z').toISOString();

    // Resolved reports with known durations: 1800s, 3600s, 7200s.
    await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'rejected',
      createdAt: day,
      resolvedAt: new Date(day.getTime() + 1800_000),
    });
    await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'resolved',
      createdAt: day,
      resolvedAt: new Date(day.getTime() + 3600_000),
      handlerPlayerId: handlerId,
    });
    await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'resolved',
      createdAt: day,
      resolvedAt: new Date(day.getTime() + 7200_000),
      handlerPlayerId: handlerId,
    });
    // Unresolved report, contributes to totals/pending but not resolution time.
    await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'pending',
      createdAt: day,
    });

    const res = await fetchAnalytics(`?from=${from}&to=${to}`, ownerCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summary: {
        total: number;
        by_status: { pending: number; in_review: number; resolved: number; rejected: number };
        avg_resolution_seconds: number;
        median_resolution_seconds: number;
      };
      trend: Array<{ day: string; count: number }>;
    };

    expect(body.summary.total).toBe(4);
    expect(body.summary.by_status).toEqual({ pending: 1, in_review: 0, resolved: 2, rejected: 1 });
    expect(body.summary.avg_resolution_seconds).toBeCloseTo(4200, 1);
    expect(body.summary.median_resolution_seconds).toBeCloseTo(3600, 1);

    const dayBucket = body.trend.find((t) => t.day === '2026-06-10');
    expect(dayBucket?.count).toBe(4);
  });

  it('attributes resolved/rejected counts to the handler in by_handler', async () => {
    const day = new Date('2026-06-11T00:00:00.000Z');
    await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'resolved',
      createdAt: day,
      resolvedAt: new Date(day.getTime() + 60_000),
      handlerPlayerId: handlerId,
    });
    await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'rejected',
      createdAt: day,
      resolvedAt: new Date(day.getTime() + 120_000),
      handlerPlayerId: handlerId,
    });

    const res = await fetchAnalytics(
      '?from=2026-06-01T00:00:00.000Z&to=2026-06-20T00:00:00.000Z',
      ownerCookie,
    );
    const body = res.json() as {
      by_handler: Array<{ player_id: string; handled: number; resolved: number; rejected: number }>;
    };
    const row = body.by_handler.find((h2) => h2.player_id === handlerId);
    expect(row).toBeDefined();
    expect(row?.handled).toBe(2);
    expect(row?.resolved).toBe(1);
    expect(row?.rejected).toBe(1);
  });

  it('counts top_targets separately for the 30d and 90d fixed windows', async () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 86_400_000); // 5 days ago: in both windows
    const midRange = new Date(now - 60 * 86_400_000); // 60 days ago: 90d only

    await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'pending',
      createdAt: recent,
    });
    await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'pending',
      createdAt: midRange,
    });

    const res = await fetchAnalytics('', ownerCookie);
    const body = res.json() as {
      top_targets: Array<{ player_id: string; count_30d: number; count_90d: number }>;
    };
    const row = body.top_targets.find((t) => t.player_id === targetAId);
    expect(row).toBeDefined();
    expect(row?.count_30d).toBe(1);
    expect(row?.count_90d).toBe(2);
  });

  it('returns text/csv with a section,key,value header row for format=csv', async () => {
    await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'pending',
      createdAt: new Date(),
    });
    const res = await fetchAnalytics('?format=csv', ownerCookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.split('\r\n')[0]).toBe('section,key,value');
  });

  it('narrows the summary to one server_id filter', async () => {
    const day = new Date('2026-06-12T00:00:00.000Z');
    await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'pending',
      createdAt: day,
    });
    await seedReport({
      serverId: serverBId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'pending',
      createdAt: day,
    });

    const res = await fetchAnalytics(
      `?server_id=${serverAId}&from=2026-06-01T00:00:00.000Z&to=2026-06-20T00:00:00.000Z`,
      ownerCookie,
    );
    const body = res.json() as { summary: { total: number } };
    expect(body.summary.total).toBe(1);
  });
});

describeIfDb('reporter stats recompute on report/action mutations (REPORT-5, #115)', () => {
  it('upserts reporter_stats on resolve, then recomputes accuracy once a moderation action confirms it', async () => {
    const reportId = await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterAId,
      targetPlayerId: targetAId,
      status: 'pending',
      createdAt: new Date(),
    });

    const handlerCookie = await loginAsSteam(HANDLER_STEAM);
    const patchRes = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportId}`,
      headers: { cookie: handlerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'resolved' }),
    });
    expect(patchRes.statusCode).toBe(200);

    const [statsAfterResolve] = await h.db
      .select()
      .from(reporterStats)
      .where(eq(reporterStats.playerId, reporterAId));
    expect(statsAfterResolve?.resolvedReports).toBe(1);
    expect(statsAfterResolve?.confirmedReports).toBe(0);
    expect(statsAfterResolve?.accuracy).toBeCloseTo(0, 5);

    vi.mocked(sendRconCommandViaWorker).mockResolvedValue(okOutcome());
    const actionRes = await h.app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/actions`,
      headers: { cookie: handlerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ action_type: 'ban', reason: 'confirmed cheating' }),
    });
    expect(actionRes.statusCode).toBe(200);

    const [statsAfterAction] = await h.db
      .select()
      .from(reporterStats)
      .where(eq(reporterStats.playerId, reporterAId));
    expect(statsAfterAction?.confirmedReports).toBe(1);
    expect(statsAfterAction?.accuracy).toBeCloseTo(1, 5);

    const linkedActions = await h.db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.reportId, reportId));
    expect(linkedActions).toHaveLength(1);
  });

  it('flags spam once 5 reports from one reporter are rejected within the 14-day window and raises the AUTO-3 alert', async () => {
    const ruleId = uuidv7();
    createdAlertRuleIds.push(ruleId);
    await h.db.insert(alertRules).values({
      id: ruleId,
      name: 'Report spam',
      type: 'custom',
      config: { eventKind: 'reports.spam_flagged', severity: 'warning' },
      channels: [],
      enabled: true,
    });

    const reportIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await seedReport({
        serverId: serverAId,
        reporterPlayerId: reporterSpamId,
        targetPlayerId: targetBId,
        status: 'pending',
        createdAt: new Date(),
      });
      reportIds.push(id);
    }

    const handlerCookie = await loginAsSteam(HANDLER_STEAM);
    for (const id of reportIds) {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `/api/v1/reports/${id}`,
        headers: { cookie: handlerCookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ status: 'rejected' }),
      });
      expect(res.statusCode).toBe(200);
    }

    const [stats] = await h.db
      .select()
      .from(reporterStats)
      .where(eq(reporterStats.playerId, reporterSpamId));
    expect(stats?.rejectedReports).toBe(5);
    expect(stats?.spamFlaggedAt).not.toBeNull();

    const events = await h.db.select().from(alertEvents).where(eq(alertEvents.ruleId, ruleId));
    expect(events.length).toBeGreaterThanOrEqual(1);

    // A 6th report from the same reporter, resolved (not rejected), does not
    // clear the flag while the 5 recent rejects are still within the window.
    const sixthId = await seedReport({
      serverId: serverAId,
      reporterPlayerId: reporterSpamId,
      targetPlayerId: targetBId,
      status: 'pending',
      createdAt: new Date(),
    });
    const sixthRes = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${sixthId}`,
      headers: { cookie: handlerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'resolved' }),
    });
    expect(sixthRes.statusCode).toBe(200);

    const [statsAfterSixth] = await h.db
      .select()
      .from(reporterStats)
      .where(eq(reporterStats.playerId, reporterSpamId));
    expect(statsAfterSixth?.spamFlaggedAt).not.toBeNull();
    expect(statsAfterSixth?.spamFlaggedAt?.getTime()).toBe(stats?.spamFlaggedAt?.getTime());
  });

  it('reflects reporter_trusted / reporter_spam_flagged / target_report_count_90d on GET /api/v1/reports', async () => {
    // 3 reports on targetBId (from reporterAId) within 90d -> recidivist count.
    for (let i = 0; i < 3; i++) {
      await seedReport({
        serverId: serverAId,
        reporterPlayerId: reporterAId,
        targetPlayerId: targetBId,
        status: 'pending',
        createdAt: new Date(),
      });
    }
    await h.db.insert(reporterStats).values({
      playerId: reporterAId,
      totalReports: 5,
      resolvedReports: 5,
      rejectedReports: 0,
      confirmedReports: 5,
      accuracy: 1,
      trusted: true,
    });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/reports?page_size=50',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        reporter_player_id: string | null;
        reporter_trusted: boolean;
        target_player_id: string | null;
        target_report_count_90d: number;
      }>;
    };
    const rows = body.items.filter((r) => r.target_player_id === targetBId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.target_report_count_90d).toBe(3);
      if (row.reporter_player_id === reporterAId) expect(row.reporter_trusted).toBe(true);
    }
  });
});
