import { randomUUID } from 'node:crypto';
import { issues, players, roleSquadPermissions, roles } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from '../integration/harness.js';

/**
 * Issue #7 — an API token's scopes must narrow the WHOLE permission context,
 * not only the catalogue permission set. Routes that authorise on role flags
 * (`canEditRoles`, `canManageBanSources`, `canManageMedia`, `canManageIssues`,
 * …), on live-Squad `squadPermissions` or on `panelAccess` must answer 403 to
 * a token that was not delegated the matching catalogue scopes, and a token
 * whose owner lost `panel_access` must stop authenticating at all.
 */

const OWNER_STEAM = testSteamId(986100);
const AUTHOR_STEAM = testSteamId(986101);
const DEMOTED_STEAM = testSteamId(986102);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let foreignIssueId: string;
let demotedNoPanelRoleId: string;

async function cookieFor(steamId64: bigint): Promise<string> {
  const [row] = await h.db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.steamId64, steamId64))
    .limit(1);
  if (!row) throw new Error(`no player for ${steamId64}`);
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'api-token-scope-test',
    ttlMs: 21_600_000,
  });
  return `__Host-sid=${token}`;
}

async function mintToken(cookie: string, scopes: string[]): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/me/tokens',
    headers: { cookie },
    payload: { name: `scope-test-${randomUUID()}`, scopes },
  });
  if (res.statusCode !== 201) throw new Error(`mint failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { plaintext: string }).plaintext;
}

const ownerTokens = new Map<string, string>();

/** Mints one Owner token per scope set: a player may hold at most 25 active tokens. */
async function ownerToken(scopes: string[]): Promise<string> {
  const key = JSON.stringify(scopes);
  const cached = ownerTokens.get(key);
  if (cached) return cached;
  const token = await mintToken(ownerCookie, scopes);
  ownerTokens.set(key, token);
  return token;
}

async function seedRole(opts: {
  panelAccess: boolean;
  canManageIssues?: boolean;
  squad?: string[];
}): Promise<string> {
  const id = randomUUID();
  await h.db.insert(roles).values({
    id,
    name: `ApiTokenScope-${id}`,
    panelAccess: opts.panelAccess,
    canManageIssues: opts.canManageIssues ?? false,
  });
  if (opts.squad?.length) {
    await h.db
      .insert(roleSquadPermissions)
      .values(opts.squad.map((squadPermissionKey) => ({ roleId: id, squadPermissionKey })));
  }
  return id;
}

async function seedPlayer(steamId64: bigint, roleId: string): Promise<string> {
  const name = `ApiTokenScope${String(steamId64).slice(-6)}`;
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64,
      canonicalName: name,
      canonicalNameNormalized: name.toLowerCase(),
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error(`failed to seed ${steamId64}`);
  return row.id;
}

interface ScopedRequest {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: () => string;
  payload?: () => Record<string, unknown>;
}

/**
 * Write routes that authorise on something other than `config.permissions`.
 * Every one is addressed at a missing resource or an offline server, so a
 * request that clears the authorisation guard answers 404/502 — never 403 —
 * and nothing is mutated either way.
 */
const FLAG_GATED_WRITES: ScopedRequest[] = [
  {
    name: 'banned-names create (squad ban)',
    method: 'POST',
    url: () => '/api/v1/banned-names',
    payload: () => ({
      pattern: `scope-probe-${randomUUID()}`,
      match_type: 'exact',
      is_active: false,
    }),
  },
  {
    name: 'banned-names delete (squad ban)',
    method: 'DELETE',
    url: () => `/api/v1/banned-names/${randomUUID()}`,
  },
  {
    name: 'vip-tiers delete (can_edit_roles)',
    method: 'DELETE',
    url: () => `/api/v1/vip-tiers/${randomUUID()}`,
  },
  {
    name: 'seasons update (can_edit_roles)',
    method: 'PATCH',
    url: () => `/api/v1/seasons/${randomUUID()}`,
    payload: () => ({ name: 'scope-probe' }),
  },
  {
    name: 'ban-sources delete (can_manage_ban_sources)',
    method: 'DELETE',
    url: () => `/api/v1/ban-sources/${randomUUID()}`,
  },
  {
    name: 'external-bans local ban (squad ban)',
    method: 'POST',
    url: () => `/api/v1/players/${randomUUID()}/external-bans/${randomUUID()}/local-ban`,
    payload: () => ({ server_id: randomUUID(), reason: 'scope-probe' }),
  },
  {
    name: 'media publication delete (can_manage_media)',
    method: 'DELETE',
    url: () => `/api/v1/media/${randomUUID()}/publications/youtube`,
  },
  {
    name: 'server broadcast (squad chat)',
    method: 'POST',
    url: () => `/api/v1/servers/${randomUUID()}/broadcast`,
    payload: () => ({ message: 'scope-probe' }),
  },
  {
    name: 'map change (squad changemap)',
    method: 'POST',
    url: () => `/api/v1/servers/${randomUUID()}/map/change`,
    payload: () => ({ layer: 'ScopeProbe_Layer_v1' }),
  },
  {
    name: 'map-vote candidates (squad changemap)',
    method: 'PUT',
    url: () => `/api/v1/servers/${randomUUID()}/map-vote/candidates`,
    payload: () => ({
      candidates: [{ layer: 'ScopeProbe_Layer_v1', weight: 1, enabled: true }],
    }),
  },
  {
    name: 'rotation write (squad changemap)',
    method: 'PUT',
    url: () => `/api/v1/servers/${randomUUID()}/rotation`,
    payload: () => ({ layers: [] }),
  },
];

async function send(req: ScopedRequest, auth: { authorization?: string; cookie?: string }) {
  return h.app.inject({
    method: req.method,
    url: req.url(),
    headers: auth,
    ...(req.payload ? { payload: req.payload() } : {}),
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'ApiTokenScopeOwner' },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);

  const authorRoleId = await seedRole({ panelAccess: true });
  const authorId = await seedPlayer(AUTHOR_STEAM, authorRoleId);
  foreignIssueId = randomUUID();
  await h.db.insert(issues).values({
    id: foreignIssueId,
    authorPlayerId: authorId,
    title: 'Scope probe issue',
    body: 'Authored by someone other than the token owner',
  });

  const demotedPanelRoleId = await seedRole({
    panelAccess: true,
    canManageIssues: true,
    squad: ['ban'],
  });
  demotedNoPanelRoleId = await seedRole({ panelAccess: false, squad: ['ban'] });
  await seedPlayer(DEMOTED_STEAM, demotedPanelRoleId);
});

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h?.cleanup();
});

describeIfDb('API token scopes narrow role flags and squad permissions (#7)', () => {
  for (const scopes of [[], ['server:view']]) {
    for (const route of FLAG_GATED_WRITES) {
      it(`403s ${route.name} for an Owner token scoped ${JSON.stringify(scopes)}`, async () => {
        const token = await ownerToken(scopes);
        const res = await send(route, { authorization: `Bearer ${token}` });
        expect(res.statusCode, res.body).toBe(403);
      });
    }
  }

  it('still serves every probe to the Owner session (the guard, not the probe, answers 403)', async () => {
    for (const route of FLAG_GATED_WRITES) {
      const res = await send(route, { cookie: ownerCookie });
      expect(res.statusCode, `${route.name}: ${res.body}`).not.toBe(403);
    }
  });

  it('keeps squad ban for a token delegated every ban-gated catalogue scope', async () => {
    const token = await ownerToken(['mod:ban_temp', 'mod:ban_perm', 'mod:unban']);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/banned-names/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('keeps can_edit_roles for a token delegated every role-editing catalogue scope', async () => {
    const token = await ownerToken(['role:create', 'role:edit', 'role:delete']);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/vip-tiers/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('403s the issue tracker for an introspection token with no scopes', async () => {
    const token = await ownerToken([]);
    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/issues',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(403);
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/issues',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'scope probe', body: 'scope probe' },
    });
    expect(create.statusCode).toBe(403);
  });

  it("403s managing someone else's issue with a token lacking the manage capability", async () => {
    const token = await ownerToken(['server:view']);
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/issues/${foreignIssueId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { state: 'closed' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not report Owner-only capabilities on /me for a scoped token', async () => {
    const token = await ownerToken(['server:view']);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.permissions).toEqual(['server:view']);
    expect(body.squad_permissions).toEqual([]);
    for (const [key, value] of Object.entries(body)) {
      if (/^(is_owner|can_)/.test(key)) expect(value, key).toBe(false);
    }
  });
});

describeIfDb('API tokens of a player who lost panel_access (#7)', () => {
  it('stop authenticating once the owner is moved to a role without panel_access', async () => {
    const token = await mintToken(await cookieFor(DEMOTED_STEAM), []);
    const before = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);

    await h.db
      .update(players)
      .set({ roleId: demotedNoPanelRoleId })
      .where(eq(players.steamId64, DEMOTED_STEAM));
    invalidateAllPermissionCaches();

    for (const url of ['/api/v1/banned-names', '/api/v1/issues', '/api/v1/message-templates']) {
      const res = await h.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, url).toBe(401);
    }
    const write = await h.app.inject({
      method: 'POST',
      url: '/api/v1/banned-names',
      headers: { authorization: `Bearer ${token}` },
      payload: { pattern: `scope-probe-${randomUUID()}`, match_type: 'exact', is_active: false },
    });
    expect(write.statusCode).toBe(401);
  });
});
