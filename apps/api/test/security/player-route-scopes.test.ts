import { randomUUID } from 'node:crypto';
import { players, roles } from '@squad/db/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { createSession } from '../../src/lib/sessions.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from '../integration/harness.js';

/**
 * Player-dossier routes that authorised only on the `panelAccess` role flag
 * (#40 findings #185, #214, #215):
 *
 * - an API token scoped to an unrelated key (`server:view`) must not read or
 *   mutate player data — the routes now declare `config.permissions`, which
 *   the global hook checks against the token-narrowed set;
 * - the mark mutations need `player:set_flags`, the reads `player:view`;
 * - combat numbers (the consolidated `/dossier`) need `combat_view`.
 *
 * Probes address a random (missing) player, so a request that clears the
 * authorisation guard answers 200/404 — never 403 — and nothing is mutated.
 */

const OWNER_STEAM = testSteamId(986400);
const NO_COMBAT_STEAM = testSteamId(986401);

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let h: IntegrationHarness;
let ownerCookie: string;
let noCombatCookie: string;
let noCombatPlayerId: string;
const tokens = new Map<string, string>();

async function ownerToken(scopes: string[]): Promise<string> {
  const key = JSON.stringify(scopes);
  const cached = tokens.get(key);
  if (cached) return cached;
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/me/tokens',
    headers: { cookie: ownerCookie },
    payload: { name: `player-route-scopes-${randomUUID()}`, scopes },
  });
  if (res.statusCode !== 201) throw new Error(`mint failed: ${res.statusCode} ${res.body}`);
  const token = (res.json() as { plaintext: string }).plaintext;
  tokens.set(key, token);
  return token;
}

interface Probe {
  name: string;
  method: 'GET' | 'POST' | 'DELETE';
  url: (playerId: string) => string;
  payload?: Record<string, unknown>;
}

const PLAYER_READS: Probe[] = [
  { name: 'marks list', method: 'GET', url: (id) => `/api/v1/players/${id}/marks` },
  { name: 'mark types', method: 'GET', url: () => '/api/v1/mark-types' },
  { name: 'active marks summary', method: 'GET', url: () => '/api/v1/marks/active-summary' },
  {
    name: 'compare-online',
    method: 'GET',
    url: (id) => `/api/v1/players/${id}/compare-online?other=${randomUUID()}`,
  },
  { name: 'coplay', method: 'GET', url: (id) => `/api/v1/players/${id}/coplay` },
  {
    name: 'ban-alt-warning',
    method: 'GET',
    url: (id) => `/api/v1/players/${id}/ban-alt-warning`,
  },
];

const COMBAT_READS: Probe[] = [
  { name: 'dossier', method: 'GET', url: (id) => `/api/v1/players/${id}/dossier` },
];

const MARK_WRITES: Probe[] = [
  {
    name: 'mark create',
    method: 'POST',
    url: (id) => `/api/v1/players/${id}/marks`,
    payload: { mark_type_id: 1 },
  },
  {
    name: 'mark clear',
    method: 'DELETE',
    url: (id) => `/api/v1/players/${id}/marks/${randomUUID()}`,
  },
];

async function send(probe: Probe, playerId: string, auth: Record<string, string>) {
  return h.app.inject({
    method: probe.method,
    url: probe.url(playerId),
    headers: auth,
    ...(probe.payload ? { payload: probe.payload } : {}),
  });
}

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM, canonicalName: 'PlayerRouteScopesOwner' },
  });
  ownerCookie = await loginAsOwner(h);

  const roleId = randomUUID();
  await h.db.insert(roles).values({
    id: roleId,
    name: `PlayerRouteScopesNoCombat-${roleId}`,
    panelAccess: true,
    combatView: false,
  });
  const [row] = await h.db
    .insert(players)
    .values({
      steamId64: NO_COMBAT_STEAM,
      canonicalName: 'PlayerRouteScopesNoCombat',
      canonicalNameNormalized: 'playerroutescopesnocombat',
      roleId,
    })
    .returning({ id: players.id });
  if (!row) throw new Error('failed to seed the combat-less player');
  noCombatPlayerId = row.id;
  invalidateAllPermissionCaches();
  const { token } = await createSession(h.db, h.redis, {
    playerId: row.id,
    ip: null,
    userAgent: 'player-route-scopes-test',
    ttlMs: 21_600_000,
  });
  noCombatCookie = `__Host-sid=${token}`;
});

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h?.cleanup();
});

describeIfDb('player routes honour API token scopes (#185, #214)', () => {
  for (const probe of [...PLAYER_READS, ...COMBAT_READS, ...MARK_WRITES]) {
    it(`403s ${probe.name} for a token scoped only to server:view`, async () => {
      const token = await ownerToken(['server:view']);
      const res = await send(probe, randomUUID(), { authorization: `Bearer ${token}` });
      expect(res.statusCode, res.body).toBe(403);
    });
  }

  for (const probe of PLAYER_READS) {
    it(`serves ${probe.name} to a token delegated player:view`, async () => {
      const token = await ownerToken(['player:view']);
      const res = await send(probe, randomUUID(), { authorization: `Bearer ${token}` });
      expect(res.statusCode, res.body).not.toBe(403);
    });
  }

  for (const probe of MARK_WRITES) {
    it(`403s ${probe.name} for a token delegated only player:view`, async () => {
      const token = await ownerToken(['player:view']);
      const res = await send(probe, randomUUID(), { authorization: `Bearer ${token}` });
      expect(res.statusCode, res.body).toBe(403);
    });

    it(`lets ${probe.name} through for a token delegated player:set_flags`, async () => {
      const token = await ownerToken(['player:set_flags']);
      const res = await send(probe, randomUUID(), { authorization: `Bearer ${token}` });
      expect(res.statusCode, res.body).not.toBe(403);
    });
  }

  it('still serves every probe to the Owner session', async () => {
    for (const probe of [...PLAYER_READS, ...COMBAT_READS, ...MARK_WRITES]) {
      const res = await send(probe, randomUUID(), { cookie: ownerCookie });
      expect(res.statusCode, `${probe.name}: ${res.body}`).not.toBe(403);
    }
  });
});

describeIfDb('combat routes require combat_view like /dossier (#215)', () => {
  for (const probe of COMBAT_READS) {
    it(`403s ${probe.name} of another player for a panel role without combat_view`, async () => {
      const res = await send(probe, randomUUID(), { cookie: noCombatCookie });
      expect(res.statusCode, res.body).toBe(403);
    });

    it(`serves ${probe.name} of the caller's own player without combat_view`, async () => {
      const res = await send(probe, noCombatPlayerId, { cookie: noCombatCookie });
      expect(res.statusCode, res.body).toBe(200);
    });
  }
});
