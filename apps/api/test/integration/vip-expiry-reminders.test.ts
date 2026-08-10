import { alertEvents, players, ROLE_EXPIRY_ALERT_RULE_ID, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRoleExpiryReminderDeps,
  runRoleExpiryReminderTick,
} from '../../../workers/role-expirer/src/reminders.js';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

const OWNER_STEAM = testSteamId(917001);
const ASSIGNER_STEAM = testSteamId(917002);
const VIEWER_STEAM = testSteamId(917003);
const VIP_STEAM = testSteamId(917004);

const DAY_MS = 24 * 60 * 60 * 1000;

let h: IntegrationHarness;
let ownerCookie: string;
let assignerCookie: string;
let viewerCookie: string;
let vipRoleId: string;

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
  canAssignRoles: boolean;
}): Promise<void> {
  const roleId = uuidv7();
  await h.db.insert(roles).values({
    id: roleId,
    name: opts.roleName,
    color: '#3366AA',
    panelAccess: true,
    canAssignRoles: opts.canAssignRoles,
  });
  const stub = `Player${String(opts.steamId64).slice(-4)}`;
  await h.db.insert(players).values({
    steamId64: opts.steamId64,
    canonicalName: stub,
    canonicalNameNormalized: stub.toLowerCase(),
    roleId,
  });
}

async function runReminderTick(now: Date): Promise<{ notified: number }> {
  const deps = createRoleExpiryReminderDeps(h.db, h.redis);
  return runRoleExpiryReminderTick({
    ...deps,
    now,
    diag: { emit: async () => undefined },
  });
}

async function roleExpiringEvents() {
  return h.db
    .select({ id: alertEvents.id, payload: alertEvents.payload })
    .from(alertEvents)
    .where(eq(alertEvents.ruleId, ROLE_EXPIRY_ALERT_RULE_ID));
}

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM } });
  await seedRoleWithPlayer({
    roleName: 'ExpiryAssigner',
    steamId64: ASSIGNER_STEAM,
    canAssignRoles: true,
  });
  await seedRoleWithPlayer({
    roleName: 'ExpiryViewer',
    steamId64: VIEWER_STEAM,
    canAssignRoles: false,
  });
  vipRoleId = uuidv7();
  await h.db.insert(roles).values({
    id: vipRoleId,
    name: 'ExpiryVip',
    color: '#AA6633',
    panelAccess: false,
  });
  await h.db.insert(players).values({
    steamId64: VIP_STEAM,
    canonicalName: 'ExpiryVipPlayer',
    canonicalNameNormalized: 'expiryvipplayer',
    roleId: vipRoleId,
    roleExpiresAt: new Date(Date.now() + 60 * DAY_MS),
  });
  ownerCookie = await loginAsOwner(h);
  assignerCookie = await loginAsSteam(ASSIGNER_STEAM, 'expiry-assigner');
  viewerCookie = await loginAsSteam(VIEWER_STEAM, 'expiry-viewer');
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

describeIfDb('VIP expiry reminders (VIPSUB-4, #170)', () => {
  it('settings round-trip persists windows and warn flag', async () => {
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        vip_expiry_windows_days: [14, 5, 2],
        vip_expiry_warn_in_game: false,
      }),
    });
    expect(put.statusCode).toBe(200);
    const putBody = put.json() as Record<string, unknown>;
    expect(putBody.vip_expiry_windows_days).toEqual([14, 5, 2]);
    expect(putBody.vip_expiry_warn_in_game).toBe(false);

    const get = await h.app.inject({
      method: 'GET',
      url: '/api/v1/settings/economy',
      headers: { cookie: ownerCookie },
    });
    expect(get.statusCode).toBe(200);
    const getBody = get.json() as Record<string, unknown>;
    expect(getBody.vip_expiry_windows_days).toEqual([14, 5, 2]);
    expect(getBody.vip_expiry_warn_in_game).toBe(false);

    // Restore the defaults so the tick tests below use [7,3,1].
    const restore = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        vip_expiry_windows_days: [7, 3, 1],
        vip_expiry_warn_in_game: true,
      }),
    });
    expect(restore.statusCode).toBe(200);
  });

  it('rejects out-of-range windows', async () => {
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ vip_expiry_windows_days: [0] }),
    });
    expect(put.statusCode).toBe(400);
  });

  it('requires can_manage_economy for the reminder settings', async () => {
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie: viewerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ vip_expiry_windows_days: [7, 3, 1] }),
    });
    expect(put.statusCode).toBe(403);
    expect((put.json() as Record<string, unknown>).required).toBe('can_manage_economy');
  });

  it('reminder tick against the harness db creates one alert_events row per window', async () => {
    const expiresAt = new Date(Date.now() + 60 * DAY_MS);
    await h.db
      .update(players)
      .set({ roleExpiresAt: expiresAt })
      .where(eq(players.steamId64, VIP_STEAM));

    // 5 days before expiry — crosses only the 7d window.
    const first = await runReminderTick(new Date(expiresAt.getTime() - 5 * DAY_MS));
    expect(first.notified).toBe(1);
    // Re-run at the same distance: dedup makes it a no-op (AC idempotency).
    const rerun = await runReminderTick(new Date(expiresAt.getTime() - 5 * DAY_MS));
    expect(rerun.notified).toBe(0);
    // 2.5 days before expiry — crosses the 3d window.
    const second = await runReminderTick(new Date(expiresAt.getTime() - 2.5 * DAY_MS));
    expect(second.notified).toBe(1);
    // 12 hours before expiry — crosses the 1d window.
    const third = await runReminderTick(new Date(expiresAt.getTime() - 0.5 * DAY_MS));
    expect(third.notified).toBe(1);

    const events = await roleExpiringEvents();
    expect(events).toHaveLength(3);
    const windows = events
      .map((event) => (event.payload as { window_days: number }).window_days)
      .sort((a, b) => a - b);
    expect(windows).toEqual([1, 3, 7]);

    // Renewal: a new expires_at re-arms the already-fired windows.
    const renewedExpiresAt = new Date(expiresAt.getTime() + 30 * DAY_MS);
    await h.db
      .update(players)
      .set({ roleExpiresAt: renewedExpiresAt })
      .where(eq(players.steamId64, VIP_STEAM));
    const renewed = await runReminderTick(new Date(renewedExpiresAt.getTime() - 2.5 * DAY_MS));
    expect(renewed.notified).toBe(1);
    expect(await roleExpiringEvents()).toHaveLength(4);
  });

  it('role_expiring alert events hidden from users without can_assign_roles and visible to those with it', async () => {
    // Ensure at least one role_expiring event exists (from the tick test or here).
    if ((await roleExpiringEvents()).length === 0) {
      await h.db.insert(alertEvents).values({
        ruleId: ROLE_EXPIRY_ALERT_RULE_ID,
        severity: 'info',
        payload: { event_kind: 'role_expiring' },
      });
    }

    const forAssigner = await h.app.inject({
      method: 'GET',
      url: '/api/v1/alerts?limit=200',
      headers: { cookie: assignerCookie },
    });
    expect(forAssigner.statusCode).toBe(200);
    const assignerRows = forAssigner.json() as Array<{ rule_type: string | null }>;
    expect(assignerRows.some((row) => row.rule_type === 'role_expiring')).toBe(true);

    const forViewer = await h.app.inject({
      method: 'GET',
      url: '/api/v1/alerts?limit=200',
      headers: { cookie: viewerCookie },
    });
    expect(forViewer.statusCode).toBe(200);
    const viewerRows = forViewer.json() as Array<{ rule_type: string | null }>;
    expect(viewerRows.some((row) => row.rule_type === 'role_expiring')).toBe(false);
  });

  it('system rule cannot be mutated (409 system_rule_immutable)', async () => {
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/alert-rules/${ROLE_EXPIRY_ALERT_RULE_ID}`,
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ enabled: false }),
    });
    expect(put.statusCode).toBe(409);
    expect((put.json() as Record<string, unknown>).error).toBe('system_rule_immutable');

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/alert-rules/${ROLE_EXPIRY_ALERT_RULE_ID}`,
      headers: { cookie: ownerCookie },
    });
    expect(del.statusCode).toBe(409);
    expect((del.json() as Record<string, unknown>).error).toBe('system_rule_immutable');
  });

  it('role_expiring cannot be created through the API', async () => {
    const post = await h.app.inject({
      method: 'POST',
      url: '/api/v1/alert-rules',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Manual expiry', type: 'role_expiring' }),
    });
    expect(post.statusCode).toBe(400);
  });
});
