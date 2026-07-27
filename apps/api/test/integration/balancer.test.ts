import {
  auditLog,
  balancerDecisions,
  balancerProposals,
  balancerSettings,
  players,
  roles,
  servers,
} from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBalancerProposalSignature } from '../../src/lib/balancer-proposal-signature.js';
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

const OWNER_STEAM = testSteamId(983001);
const NO_PANEL_STEAM = testSteamId(983002);

const SECRET = 'balancer-webhook-integration-secret-entropy';
const SIGNED_AT = '2026-07-27T09:00:00.000Z';

const SERVER_ID = '019e0083-0000-7000-8000-0000000000a1';
const OTHER_SERVER_ID = '019e0083-0000-7000-8000-0000000000b2';

let h: IntegrationHarness;
let ownerCookie: string;
let noPanelCookie: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

interface SettingsBody {
  settings: {
    enabled: boolean;
    win_streak_threshold: number;
    ticket_diff_threshold: number;
    one_sided_rounds_threshold: number;
    quorum: number;
    pass_threshold_pct: number;
    require_moderator_veto: boolean;
    prefer_squad_grouping: boolean;
    player_level_enabled: boolean;
    updated_at: string | null;
    updated_by_player_id: string | null;
  };
}

interface ProposalView {
  id: string;
  source_snapshot_id: string;
  server_id: string;
  match_id: string | null;
  layer: string | null;
  gamemode: string | null;
  mode: string;
  schema_version: number;
  status: string;
  generated_at: string;
  signals: Record<string, unknown>;
  proposal: Array<Record<string, unknown>>;
  evaluation: {
    triggered: boolean;
    reasons: Array<{ kind: string; observed: number; threshold: number }>;
  };
}

interface ProposalListBody {
  items: ProposalView[];
  next_cursor: string | null;
}

interface ProposalDetailBody extends ProposalView {
  decisions: Array<{
    id: string;
    decision: string;
    veto_reason_kind: string | null;
    veto_reason: string | null;
    decided_by_player_id: string | null;
    created_at: string;
  }>;
}

function snapshotPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_snapshot_id: 'balancer-snapshot-001',
    server_id: SERVER_ID,
    mode: 'squad',
    generated_at: '2026-07-27T08:55:00.000Z',
    layer: 'Yehorivka_RAAS_v1',
    gamemode: 'RAAS',
    signals: { win_streak: 4, ticket_diff: -320, one_sided_rounds: 3 },
    proposal: [
      {
        subject_type: 'squad',
        subject_id: 'sq-alpha',
        label: 'Alpha',
        current_team: 1,
        target_team: 2,
        state: 'should_move',
      },
      {
        subject_type: 'squad',
        subject_id: 'sq-bravo',
        label: 'Bravo',
        current_team: 2,
        target_team: 2,
        state: 'on_target',
      },
    ],
    ...overrides,
  };
}

function postSnapshot(payload: Record<string, unknown>, signature?: string) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/integrations/balancer/proposals',
    headers: {
      'content-type': 'application/json',
      'x-balancer-timestamp': SIGNED_AT,
      'x-balancer-signature':
        signature ?? createBalancerProposalSignature(SECRET, SIGNED_AT, payload),
    },
    payload: JSON.stringify(payload),
  });
}

/**
 * Polls for the `balancer.settings.update` audit row of a request that ended
 * with `statusCode`. `assertAuditRow` returns the newest matching row, which is
 * ambiguous here because the audit hook also records the rejected attempts made
 * by the sibling tests and writes them asynchronously.
 */
async function waitForSettingsAudit(statusCode: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const rows = await h.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actionType, 'balancer.settings.update'),
          eq(auditLog.statusCode, statusCode),
        ),
      )
      .limit(1);
    const first = rows[0];
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no balancer.settings.update audit row with statusCode=${statusCode}`);
}

async function loginAsSteam(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`no player for steamId64=${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'balancer-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'BalancerOwner' },
    bridge: makeFakeBridge(),
  });
  (h.app.config as Record<string, unknown>).BALANCER_WEBHOOK_SECRET = SECRET;
  ownerCookie = await loginAsOwner(h);

  const queuePriority = await h.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'QueuePriority'))
    .limit(1);
  await h.db.insert(players).values({
    steamId64: NO_PANEL_STEAM,
    canonicalName: 'BalancerNoPanel',
    canonicalNameNormalized: 'balancernopanel',
    roleId: queuePriority[0]?.id ?? null,
  });
  noPanelCookie = await loginAsSteam(NO_PANEL_STEAM);

  await h.db.insert(servers).values([
    { id: SERVER_ID, displayName: 'Balancer server', slug: 'balancer-server' },
    { id: OTHER_SERVER_ID, displayName: 'Balancer other', slug: 'balancer-other' },
  ]);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

beforeEach(async () => {
  await h.db.delete(balancerDecisions);
  await h.db.delete(balancerProposals);
  await h.db.delete(balancerSettings);
});

describeIfDb('GET/PUT /api/v1/balancer/settings', () => {
  it('rejects unauthenticated access with 401', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/balancer/settings' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a role without the balancer:view key with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/balancer/settings',
      headers: { cookie: noPanelCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns the documented defaults before any row exists', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/balancer/settings',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SettingsBody).settings).toEqual({
      enabled: false,
      win_streak_threshold: 3,
      ticket_diff_threshold: 150,
      one_sided_rounds_threshold: 2,
      quorum: 5,
      pass_threshold_pct: 60,
      require_moderator_veto: false,
      prefer_squad_grouping: true,
      player_level_enabled: false,
      updated_at: null,
      updated_by_player_id: null,
    });
  });

  it('rejects a settings write from a role without balancer:edit with 403', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/balancer/settings',
      headers: { cookie: noPanelCookie },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an out-of-range pass threshold with 400 and persists nothing', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/balancer/settings',
      headers: { cookie: ownerCookie },
      payload: { pass_threshold_pct: 101 },
    });
    expect(res.statusCode).toBe(400);
    expect(await h.db.select().from(balancerSettings)).toHaveLength(0);
  });

  it('rejects a win streak threshold below 1 with 400', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/balancer/settings',
      headers: { cookie: ownerCookie },
      payload: { win_streak_threshold: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty settings body with 400', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/balancer/settings',
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('upserts the singleton, records the actor and writes a balancer.settings.update audit row', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/balancer/settings',
      headers: { cookie: ownerCookie },
      payload: {
        enabled: true,
        win_streak_threshold: 5,
        ticket_diff_threshold: 400,
        player_level_enabled: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = (res.json() as SettingsBody).settings;
    expect(body).toMatchObject({
      enabled: true,
      win_streak_threshold: 5,
      ticket_diff_threshold: 400,
      player_level_enabled: true,
      one_sided_rounds_threshold: 2,
      updated_by_player_id: h.seed.ownerPlayerId,
    });

    const rows = await h.db.select().from(balancerSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.winStreakThreshold).toBe(5);

    const audit = await assertAuditRow(h, {
      action: 'balancer.settings.update',
      resource: 'balancer_settings',
    });
    expect(audit.actionType).toBe('balancer.settings.update');
    // The declarative audit hook records rejected attempts too, and it runs
    // fire-and-forget after inject() resolves — so "newest row" is not
    // necessarily this request's. Assert the accepted write explicitly.
    const accepted = await waitForSettingsAudit(200);
    expect(accepted.actorPlayerId).toBe(h.seed.ownerPlayerId);

    const second = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/balancer/settings',
      headers: { cookie: ownerCookie },
      payload: { quorum: 9 },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as SettingsBody).settings).toMatchObject({
      quorum: 9,
      win_streak_threshold: 5,
    });
    expect(await h.db.select().from(balancerSettings)).toHaveLength(1);
  });
});

describeIfDb('POST /api/v1/integrations/balancer/proposals', () => {
  it('is disabled with 503 when BALANCER_WEBHOOK_SECRET is unset', async () => {
    const config = h.app.config as Record<string, unknown>;
    config.BALANCER_WEBHOOK_SECRET = undefined;
    try {
      const res = await postSnapshot(snapshotPayload());
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'balancer_webhook_disabled' });
    } finally {
      config.BALANCER_WEBHOOK_SECRET = SECRET;
    }
  });

  it('rejects an invalid signature with 401 and stores nothing', async () => {
    const res = await postSnapshot(snapshotPayload(), 'sha256=deadbeef');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_signature' });
    expect(await h.db.select().from(balancerProposals)).toHaveLength(0);
  });

  it('rejects a snapshot for an unknown server with 404', async () => {
    const payload = snapshotPayload({ server_id: '019e0083-0000-7000-8000-00000000ffff' });
    const res = await postSnapshot(payload);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'server_not_found' });
  });

  it('stores a signed snapshot and is idempotent on the same source_snapshot_id', async () => {
    const payload = snapshotPayload();

    const first = await postSnapshot(payload);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ ok: true, duplicate: false });

    const duplicate = await postSnapshot(payload);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ ok: true, duplicate: true });

    const rows = await h.db
      .select()
      .from(balancerProposals)
      .where(eq(balancerProposals.sourceSnapshotId, 'balancer-snapshot-001'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mode).toBe('squad');
    expect(rows[0]?.schemaVersion).toBe(1);
    expect(rows[0]?.signals).toMatchObject({ win_streak: 4 });
    expect(rows[0]?.proposal).toHaveLength(2);
  });

  it('supersedes the previous open snapshot for the same server and mode only', async () => {
    await postSnapshot(snapshotPayload());
    await postSnapshot(
      snapshotPayload({ source_snapshot_id: 'balancer-snapshot-player', mode: 'player' }),
    );
    await postSnapshot(snapshotPayload({ source_snapshot_id: 'balancer-snapshot-002' }));

    const byKey = new Map(
      (await h.db.select().from(balancerProposals)).map((row) => [row.sourceSnapshotId, row]),
    );
    expect(byKey.get('balancer-snapshot-001')?.status).toBe('superseded');
    expect(byKey.get('balancer-snapshot-002')?.status).toBe('open');
    expect(byKey.get('balancer-snapshot-player')?.status).toBe('open');
  });

  it('rejects a proposal entry with an unknown diff state with 400', async () => {
    const payload = snapshotPayload({
      proposal: [
        {
          subject_type: 'squad',
          subject_id: 'sq-alpha',
          label: 'Alpha',
          current_team: 1,
          target_team: 2,
          state: 'teleport',
        },
      ],
    });
    const res = await postSnapshot(payload);
    expect(res.statusCode).toBe(400);
    expect(await h.db.select().from(balancerProposals)).toHaveLength(0);
  });
});

describeIfDb('GET /api/v1/balancer/proposals', () => {
  it('returns an empty page with HTTP 200 when no snapshot has arrived', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/balancer/proposals',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], next_cursor: null });
  });

  it('rejects a role without balancer:view with 403', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/balancer/proposals',
      headers: { cookie: noPanelCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('evaluates stored signals against the configured thresholds', async () => {
    await postSnapshot(snapshotPayload());

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/balancer/proposals',
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as ProposalListBody;
    expect(body.items).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
    expect(body.items[0]?.evaluation).toEqual({
      triggered: true,
      reasons: [
        { kind: 'win_streak', observed: 4, threshold: 3 },
        { kind: 'ticket_diff', observed: 320, threshold: 150 },
        { kind: 'one_sided_rounds', observed: 3, threshold: 2 },
      ],
    });
  });

  it('reports a healthy evaluation when the thresholds are raised above the signals', async () => {
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/balancer/settings',
      headers: { cookie: ownerCookie },
      payload: {
        win_streak_threshold: 10,
        ticket_diff_threshold: 900,
        one_sided_rounds_threshold: 9,
      },
    });
    await postSnapshot(snapshotPayload());

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/balancer/proposals',
      headers: { cookie: ownerCookie },
    });
    const body = res.json() as ProposalListBody;
    expect(body.items[0]?.evaluation).toEqual({ triggered: false, reasons: [] });
  });

  it('filters by mode, status and server, and paginates with a cursor', async () => {
    await postSnapshot(snapshotPayload({ source_snapshot_id: 'p-1' }));
    await postSnapshot(
      snapshotPayload({
        source_snapshot_id: 'p-2',
        generated_at: '2026-07-27T08:56:00.000Z',
      }),
    );
    await postSnapshot(snapshotPayload({ source_snapshot_id: 'p-3', mode: 'player' }));
    await postSnapshot(snapshotPayload({ source_snapshot_id: 'p-4', server_id: OTHER_SERVER_ID }));

    const byMode = await h.app.inject({
      method: 'GET',
      url: '/api/v1/balancer/proposals?mode=player',
      headers: { cookie: ownerCookie },
    });
    expect((byMode.json() as ProposalListBody).items.map((i) => i.source_snapshot_id)).toEqual([
      'p-3',
    ]);

    const byServer = await h.app.inject({
      method: 'GET',
      url: `/api/v1/balancer/proposals?server_id=${OTHER_SERVER_ID}`,
      headers: { cookie: ownerCookie },
    });
    expect((byServer.json() as ProposalListBody).items.map((i) => i.source_snapshot_id)).toEqual([
      'p-4',
    ]);

    const bySuperseded = await h.app.inject({
      method: 'GET',
      url: '/api/v1/balancer/proposals?status=superseded',
      headers: { cookie: ownerCookie },
    });
    expect(
      (bySuperseded.json() as ProposalListBody).items.map((i) => i.source_snapshot_id),
    ).toEqual(['p-1']);

    const firstPage = await h.app.inject({
      method: 'GET',
      url: '/api/v1/balancer/proposals?server_id=all&limit=2',
      headers: { cookie: ownerCookie },
    });
    const firstBody = firstPage.json() as ProposalListBody;
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.next_cursor).not.toBeNull();

    const secondPage = await h.app.inject({
      method: 'GET',
      url: `/api/v1/balancer/proposals?limit=2&cursor=${encodeURIComponent(String(firstBody.next_cursor))}`,
      headers: { cookie: ownerCookie },
    });
    const secondBody = secondPage.json() as ProposalListBody;
    expect(secondBody.items).toHaveLength(2);
    const seen = [...firstBody.items, ...secondBody.items].map((i) => i.source_snapshot_id);
    expect(new Set(seen).size).toBe(4);
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/balancer/proposals?cursor=not-a-cursor',
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_cursor' });
  });
});

describeIfDb('GET /api/v1/balancer/proposals/:id', () => {
  it('returns 404 proposal_not_found for an unknown id', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/balancer/proposals/${uuidv7()}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'proposal_not_found' });
  });

  it('returns the full signals blob, diff payload and decision history', async () => {
    const created = await postSnapshot(snapshotPayload());
    const proposalId = (created.json() as { proposal_id: string }).proposal_id;

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/balancer/proposals/${proposalId}`,
      headers: { cookie: ownerCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as ProposalDetailBody;
    expect(body.id).toBe(proposalId);
    expect(body.layer).toBe('Yehorivka_RAAS_v1');
    expect(body.gamemode).toBe('RAAS');
    expect(body.signals).toEqual({ win_streak: 4, ticket_diff: -320, one_sided_rounds: 3 });
    expect(body.proposal).toHaveLength(2);
    expect(body.proposal[0]).toMatchObject({ subject_id: 'sq-alpha', state: 'should_move' });
    expect(body.decisions).toEqual([]);
  });
});

describeIfDb('POST /api/v1/balancer/proposals/:id/decision', () => {
  async function seedProposal(): Promise<string> {
    const created = await postSnapshot(snapshotPayload());
    return (created.json() as { proposal_id: string }).proposal_id;
  }

  it('returns 404 for an unknown proposal', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/balancer/proposals/${uuidv7()}/decision`,
      headers: { cookie: ownerCookie },
      payload: { decision: 'acknowledge' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'proposal_not_found' });
  });

  it('rejects a decision from a role without balancer:edit with 403', async () => {
    const proposalId = await seedProposal();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/balancer/proposals/${proposalId}/decision`,
      headers: { cookie: noPanelCookie },
      payload: { decision: 'acknowledge' },
    });
    expect(res.statusCode).toBe(403);
    expect(await h.db.select().from(balancerDecisions)).toHaveLength(0);
  });

  it('rejects a veto without a reason with 400 veto_reason_required', async () => {
    const proposalId = await seedProposal();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/balancer/proposals/${proposalId}/decision`,
      headers: { cookie: ownerCookie },
      payload: { decision: 'veto', veto_reason_kind: 'seeding' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'veto_reason_required' });
    expect(await h.db.select().from(balancerDecisions)).toHaveLength(0);
    const [row] = await h.db
      .select()
      .from(balancerProposals)
      .where(eq(balancerProposals.id, proposalId));
    expect(row?.status).toBe('open');
  });

  it('persists an acknowledgement, flips the status to reviewed and audits it', async () => {
    const proposalId = await seedProposal();

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/balancer/proposals/${proposalId}/decision`,
      headers: { cookie: ownerCookie },
      payload: { decision: 'acknowledge' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ decision: 'acknowledge', status: 'reviewed' });

    const decisionRows = await h.db
      .select()
      .from(balancerDecisions)
      .where(eq(balancerDecisions.proposalId, proposalId));
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0]?.decidedByPlayerId).toBe(h.seed.ownerPlayerId);

    const [proposalRow] = await h.db
      .select()
      .from(balancerProposals)
      .where(eq(balancerProposals.id, proposalId));
    expect(proposalRow?.status).toBe('reviewed');

    const audit = await assertAuditRow(h, {
      action: 'balancer.proposal.decision',
      resource: 'balancer_proposal',
      targetId: proposalId,
    });
    expect(audit.statusCode).toBe(201);
  });

  it('persists a veto with its reason and a dismissal that flips the status to dismissed', async () => {
    const proposalId = await seedProposal();

    const veto = await h.app.inject({
      method: 'POST',
      url: `/api/v1/balancer/proposals/${proposalId}/decision`,
      headers: { cookie: ownerCookie },
      payload: {
        decision: 'veto',
        veto_reason_kind: 'clan_match',
        veto_reason: 'Клановый матч, состав менять нельзя',
      },
    });
    expect(veto.statusCode).toBe(201);
    expect(veto.json()).toMatchObject({ decision: 'veto', status: 'reviewed' });

    const dismiss = await h.app.inject({
      method: 'POST',
      url: `/api/v1/balancer/proposals/${proposalId}/decision`,
      headers: { cookie: ownerCookie },
      payload: { decision: 'dismiss' },
    });
    expect(dismiss.statusCode).toBe(201);
    expect(dismiss.json()).toMatchObject({ decision: 'dismiss', status: 'dismissed' });

    const detail = await h.app.inject({
      method: 'GET',
      url: `/api/v1/balancer/proposals/${proposalId}`,
      headers: { cookie: ownerCookie },
    });
    const body = detail.json() as ProposalDetailBody;
    expect(body.status).toBe('dismissed');
    expect(body.decisions.map((d) => d.decision)).toEqual(['dismiss', 'veto']);
    expect(body.decisions[1]).toMatchObject({
      veto_reason_kind: 'clan_match',
      veto_reason: 'Клановый матч, состав менять нельзя',
    });
  });

  it('rejects an unknown decision verb with 400', async () => {
    const proposalId = await seedProposal();
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/balancer/proposals/${proposalId}/decision`,
      headers: { cookie: ownerCookie },
      payload: { decision: 'force_swap' },
    });
    expect(res.statusCode).toBe(400);
  });
});
