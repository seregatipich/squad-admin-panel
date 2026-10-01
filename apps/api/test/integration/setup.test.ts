import { panelMeta, players, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { resetSetupState, testSteamId } from '../helpers/snapshot-restore.js';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

// Regression coverage for INFRA-7 (setup wizard). The acceptance criteria:
//   1. a repeat call to the mutating setup endpoint after completion → 410;
//   2. the wizard is unreachable after completion and on a direct URL visit.
// (2) is satisfied for the client-rendered wizard by `/setup/status` reporting
// `setup_completed: true`, on which the SPA redirects away — so these tests also
// lock in that `/status` intentionally keeps serving 200 after completion.

const OWNER_STEAM = testSteamId(137001);
const NON_OWNER_STEAM = testSteamId(137002);

let h: IntegrationHarness;
let ownerCookie: string;
let nonOwnerCookie: string;

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
    userAgent: 'setup-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function resetPanelMeta(opts?: { firstOwnerClaimed?: boolean }): Promise<void> {
  await resetSetupState(h.db, { firstOwnerClaimed: opts?.firstOwnerClaimed ?? false });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'SetupOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  // A second, authenticated panel user who is not the Owner: they reach the
  // setup handler (a session without panel_access is dropped to anonymous, #33),
  // so `/setup/complete` must reject them with 403.
  const [strangerRole] = await h.db
    .insert(roles)
    .values({
      id: uuidv7(),
      name: 'SetupStranger',
      color: 'neutral',
      isSystemRole: false,
      panelAccess: true,
    })
    .returning({ id: roles.id });
  if (!strangerRole) throw new Error('failed to seed the stranger role');
  await h.db.insert(players).values({
    steamId64: NON_OWNER_STEAM,
    canonicalName: 'SetupStranger',
    canonicalNameNormalized: 'setupstranger',
    roleId: strangerRole.id,
  });
  nonOwnerCookie = await loginAsSteam(NON_OWNER_STEAM);
});

afterAll(async () => {
  await h.cleanup();
});

beforeEach(async () => {
  await resetPanelMeta();
});

describeIfDb('GET /api/v1/setup/status', () => {
  it('returns the documented shape before completion (public, no auth)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ setup_completed: false, first_owner_claimed: false });
  });

  it('reflects first_owner_claimed independently of setup_completed', async () => {
    await resetPanelMeta({ firstOwnerClaimed: true });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ setup_completed: false, first_owner_claimed: true });
  });

  it('still serves 200 with setup_completed:true after completion (drives the wizard redirect)', async () => {
    await resetPanelMeta({ firstOwnerClaimed: true });
    const complete = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { organization_name: 'Redirect Clan' },
    });
    expect(complete.statusCode).toBe(200);

    const res = await h.app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ setup_completed: true, first_owner_claimed: true });
  });
});

describeIfDb('POST /api/v1/setup/complete', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { 'content-type': 'application/json' },
      payload: { organization_name: 'Anon Clan' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('rejects an authenticated non-owner with 403', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { cookie: nonOwnerCookie, 'content-type': 'application/json' },
      payload: { organization_name: 'Stranger Clan' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'only_owner_can_complete_setup' });

    const [row] = await h.db.select().from(panelMeta).where(eq(panelMeta.id, 1)).limit(1);
    expect(row?.setupCompleted).toBe(false);
    expect(row?.organizationName).toBe('');
  });

  it('rejects an empty organization name with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { organization_name: '   ' },
    });
    expect(res.statusCode).toBe(400);

    const [row] = await h.db.select().from(panelMeta).where(eq(panelMeta.id, 1)).limit(1);
    expect(row?.setupCompleted).toBe(false);
  });

  it('completes for the owner and persists the org name + setup_completed flag', async () => {
    const startedAt = Date.now();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { organization_name: '  Breaking Squad  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [row] = await h.db.select().from(panelMeta).where(eq(panelMeta.id, 1)).limit(1);
    expect(row?.setupCompleted).toBe(true);
    // z.string().trim() normalises the stored name.
    expect(row?.organizationName).toBe('Breaking Squad');

    // Only rows written since this request count: earlier tests in the file
    // audit their own (refused or successful) setup.complete calls, and this
    // row may still be in flight when the first poll runs.
    const auditRow = await assertAuditRow(h, {
      action: 'setup.complete',
      resource: 'panel',
      statusCode: 200,
      withinMs: Date.now() - startedAt + 1,
    });
    // Regression for finding #350: the audit row must record the org name
    // that was actually saved, via req.auditSnapshots.
    expect(auditRow.beforeSnapshot).toEqual({ organization_name: '' });
    expect(auditRow.afterSnapshot).toEqual({ organization_name: 'Breaking Squad' });
  });

  // Regression test for finding #350: the UPDATE used to be unconditional
  // (WHERE id = 1 only), so two concurrent completions could both appear to
  // succeed and the second would silently overwrite the first's org name.
  // Scoping the UPDATE to setup_completed = false means only the first
  // commit can ever return a row.
  it('only the first of two concurrent completions succeeds; the loser sees 410', async () => {
    const [first, second] = await Promise.all([
      h.app.inject({
        method: 'POST',
        url: '/api/v1/setup/complete',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: { organization_name: 'Racer One' },
      }),
      h.app.inject({
        method: 'POST',
        url: '/api/v1/setup/complete',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: { organization_name: 'Racer Two' },
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 410]);

    const [row] = await h.db.select().from(panelMeta).where(eq(panelMeta.id, 1)).limit(1);
    expect(row?.setupCompleted).toBe(true);
    expect(['Racer One', 'Racer Two']).toContain(row?.organizationName);
  });

  it('returns 410 setup_already_completed on a repeat completion by the owner', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { organization_name: 'First Name' },
    });
    expect(first.statusCode).toBe(200);

    const repeat = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { organization_name: 'Overwrite Attempt' },
    });
    expect(repeat.statusCode).toBe(410);
    expect(repeat.json()).toMatchObject({ error: 'setup_already_completed' });

    // The repeat must not overwrite the persisted organization name.
    const [row] = await h.db.select().from(panelMeta).where(eq(panelMeta.id, 1)).limit(1);
    expect(row?.organizationName).toBe('First Name');
  });

  it('returns 410 for an authenticated non-owner after completion; 401 for an anonymous caller (#246)', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: { organization_name: 'Locked Clan' },
    });
    expect(first.statusCode).toBe(200);

    // #246: POST /api/v1/setup/complete deliberately declares neither
    // config.public nor config.permissions (its in-handler 410-before-401
    // precedence was already correct for an authenticated caller), so the
    // global fail-closed auth hook now gates an anonymous caller with 401
    // before the handler's own setupCompleted check ever runs. This used to
    // be 410 under the old fail-open default, which let anonymous requests
    // reach the handler at all; 401 is strictly more restrictive, not a
    // regression.
    const anon = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { 'content-type': 'application/json' },
      payload: { organization_name: 'Anon Retry' },
    });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toMatchObject({ error: 'unauthenticated' });

    // An authenticated non-owner still reaches the handler (the hook only
    // requires a session, not a permission, on this undecorated route), so
    // the completion gate still precedes the ownership check for them.
    const stranger = await h.app.inject({
      method: 'POST',
      url: '/api/v1/setup/complete',
      headers: { cookie: nonOwnerCookie, 'content-type': 'application/json' },
      payload: { organization_name: 'Stranger Retry' },
    });
    expect(stranger.statusCode).toBe(410);
    expect(stranger.json()).toMatchObject({ error: 'setup_already_completed' });
  });
});
