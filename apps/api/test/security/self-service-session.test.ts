import { randomUUID } from 'node:crypto';
import { players, rolePermissions, roles, sessions } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from '../integration/harness.js';

const OWNER_STEAM = testSteamId(985900);
const VIP_STEAM = testSteamId(985901);
const PANEL_STEAM = testSteamId(985902);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let selfServiceCookie: string;
let panelScopedCookie: string;
let panelPlayerSelfServiceCookie: string;
let vipPlayerId: string;
let panelPlayerId: string;

/**
 * Routes a self-service session must NOT reach. Deliberately drawn from the
 * three families a widened session-minting path could otherwise expose
 * (VIPSUB-5, #171):
 *  - `config.permissions` routes, enforced in `plugins/auth.ts`;
 *  - hand-guarded `panelAccess` routes;
 *  - routes whose only guard is `if (!req.user) 401` — `issues.ts`,
 *    `message-templates.ts`, `banned-names.ts`. Those three would leak the
 *    whole issue tracker, the admin message templates and the name-filter
 *    rules to any logged-in VIP if the session were not scoped.
 */
const FORBIDDEN_ROUTES: Array<{ method: 'GET'; url: string }> = [
  { method: 'GET', url: '/api/v1/players' },
  { method: 'GET', url: '/api/v1/roles' },
  { method: 'GET', url: '/api/v1/audit' },
  { method: 'GET', url: '/api/v1/servers' },
  { method: 'GET', url: '/api/v1/issues' },
  { method: 'GET', url: '/api/v1/issues/labels' },
  { method: 'GET', url: '/api/v1/message-templates' },
  { method: 'GET', url: '/api/v1/banned-names' },
  { method: 'GET', url: '/api/v1/bonus-shop/tiers' },
  { method: 'GET', url: '/api/v1/me/tokens' },
  { method: 'GET', url: '/api/v1/me/sessions' },
  { method: 'GET', url: '/api/v1/me/names' },
];

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'SelfServiceOwner' },
    bridge: makeFakeBridge(),
  });

  const vipRoleId = randomUUID();
  const panelRoleId = randomUUID();
  await h.db.insert(roles).values([
    { id: vipRoleId, name: `SelfServiceVip-${vipRoleId}`, panelAccess: false },
    { id: panelRoleId, name: `SelfServicePanel-${panelRoleId}`, panelAccess: true },
  ]);
  // A role with an explicit panel permission grant but no panel_access:
  // `rbac.ts` adds `role_permissions` rows on top of the derived set, so the
  // permission set alone is NOT what keeps this player out of the panel.
  await h.db.insert(rolePermissions).values([{ roleId: vipRoleId, permissionKey: 'player:view' }]);

  const [vip] = await h.db
    .insert(players)
    .values({
      steamId64: VIP_STEAM,
      canonicalName: 'SelfServiceVipPlayer',
      canonicalNameNormalized: 'selfservicevipplayer',
      roleId: vipRoleId,
    })
    .returning({ id: players.id });
  const [panel] = await h.db
    .insert(players)
    .values({
      steamId64: PANEL_STEAM,
      canonicalName: 'SelfServicePanelPlayer',
      canonicalNameNormalized: 'selfservicepanelplayer',
      roleId: panelRoleId,
    })
    .returning({ id: players.id });
  if (!vip || !panel) throw new Error('failed to seed self-service fixtures');
  vipPlayerId = vip.id;
  panelPlayerId = panel.id;

  invalidateAllPermissionCaches();
  const vipSession = await createSession(h.db, h.redis, {
    playerId: vipPlayerId,
    ip: null,
    userAgent: 'self-service-test',
    ttlMs: 21_600_000,
    scope: 'self_service',
  });
  selfServiceCookie = `__Host-sid=${vipSession.token}`;

  const panelSession = await createSession(h.db, h.redis, {
    playerId: panelPlayerId,
    ip: null,
    userAgent: 'self-service-test',
    ttlMs: 21_600_000,
  });
  panelScopedCookie = `__Host-sid=${panelSession.token}`;

  const upgraded = await createSession(h.db, h.redis, {
    playerId: panelPlayerId,
    ip: null,
    userAgent: 'self-service-test',
    ttlMs: 21_600_000,
    scope: 'self_service',
  });
  panelPlayerSelfServiceCookie = `__Host-sid=${upgraded.token}`;
}, 90_000);

afterAll(async () => {
  await h?.cleanup();
});

describeIfDb('self-service session scope (VIPSUB-5)', () => {
  it('defaults createSession to the panel scope', async () => {
    const rows = await h.db
      .select({ scope: sessions.scope })
      .from(sessions)
      .where(eq(sessions.playerId, panelPlayerId));
    expect(rows.map((r) => r.scope).sort()).toEqual(['panel', 'self_service']);
  });

  for (const route of FORBIDDEN_ROUTES) {
    it(`denies ${route.method} ${route.url} to a self-service session`, async () => {
      const res = await h.app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie: selfServiceCookie },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unauthenticated' });
    });
  }

  it('denies a self-service session another player’s bonus balance', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${panelPlayerId}/bonus-balance`,
      headers: { cookie: selfServiceCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('denies a self-service session its own panel-gated player card', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${vipPlayerId}/bonus-balance`,
      headers: { cookie: selfServiceCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  // Досье теперь читается и без `combat:view`, если игрок смотрит своё, —
  // на этом стоит блок статистики на странице «Аккаунт». Послабление живёт
  // внутри маршрута и не должно превращать его в self-service.
  it('denies a self-service session its own dossier', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/players/${vipPlayerId}/dossier`,
      headers: { cookie: selfServiceCookie },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('still identifies the player on GET /api/v1/me', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: selfServiceCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ player_id: vipPlayerId, permissions: ['player:view'] });
  });

  it('leaves a panel-scoped session untouched by the gate', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues/labels',
      headers: { cookie: panelScopedCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('lifts the gate for a self-service session whose player does hold panel access', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues/labels',
      headers: { cookie: panelPlayerSelfServiceCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('still lets the player log out', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: selfServiceCookie },
    });
    expect(res.statusCode).toBe(200);
  });
});
