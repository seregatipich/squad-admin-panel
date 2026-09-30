import { playerReports, players, servers } from '@squad/db/schema';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

vi.mock('../src/lib/report-notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/report-notify.js')>()),
  notifyReporter: vi.fn(async () => {
    throw new Error('rcon unavailable');
  }),
}));
vi.mock('../src/lib/reporter-stats.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/reporter-stats.js')>()),
  recomputeReporterStats: vi.fn(async () => {
    throw new Error('stats table locked');
  }),
}));

const OWNER_STEAM = testSteamId(717001);
const REPORTER_STEAM = testSteamId(717002);

/**
 * Audit #71 (#262): the reporter-stats recompute and reporter notification
 * after a report PATCH are best-effort, but their failures must be logged and
 * recorded distinctly in the audit context instead of vanishing.
 */
describe('PATCH /api/v1/reports/:id best-effort side effects', () => {
  let h: IntegrationHarness;
  let reportId: string;

  beforeAll(async () => {
    h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });
    const [reporter] = await h.db
      .insert(players)
      .values({
        steamId64: REPORTER_STEAM,
        canonicalName: 'SideEffectReporter',
        canonicalNameNormalized: 'sideeffectreporter',
      })
      .returning({ id: players.id });
    const serverId = uuidv7();
    await h.db
      .insert(servers)
      .values({ id: serverId, displayName: 'Side effects', slug: `side-${serverId}` });
    const [report] = await h.db
      .insert(playerReports)
      .values({
        serverId,
        reporterPlayerId: reporter?.id ?? null,
        body: 'side effects fixture',
        source: 'ui',
        status: 'pending',
      })
      .returning({ id: playerReports.id });
    reportId = report?.id ?? '';
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  it('logs both failures and flags them in the audit context while the PATCH succeeds', async () => {
    const warn = vi.spyOn(h.app.log, 'warn');
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/reports/${reportId}`,
      headers: { cookie: await loginAsOwner(h) },
      payload: { status: 'resolved' },
    });
    expect(res.statusCode).toBe(200);

    const messages = warn.mock.calls.map((call) => call.at(-1));
    expect(messages).toContain('report: reporter stats recompute failed');
    expect(messages).toContain('report: reporter notification failed');

    const audit = await assertAuditRow(h, { action: 'report.update', targetId: reportId });
    expect(audit.context).toMatchObject({
      recompute_failed: true,
      notified: false,
      notify_failed: true,
    });
    warn.mockRestore();
  });
});
