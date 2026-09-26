import { playerApiTokens } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000002000n;

async function mintToken(
  h: IntegrationHarness,
  cookie: string,
  scopes: string[],
): Promise<{ id: string; plaintext: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/me/tokens',
    headers: { cookie },
    payload: { name: 'bearer-test', scopes },
  });
  if (res.statusCode !== 201) throw new Error(`mint failed: ${res.statusCode} ${res.body}`);
  return res.json() as { id: string; plaintext: string };
}

describe('Bearer auth via /api/v1/me', () => {
  let h: IntegrationHarness;
  let cookie: string;
  // Every test mints and inspects its own token, so one owner and one app
  // serve the whole file.
  beforeAll(async () => {
    h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
    cookie = await loginAsOwner(h);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('authenticates with Authorization: Bearer and intersects scopes', async () => {
    const { plaintext } = await mintToken(h, cookie, ['server:view', 'audit:view']);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { steam_id64: string; permissions: string[] };
    expect(body.steam_id64).toBe(String(OWNER_STEAM_ID));
    expect(body.permissions.sort()).toEqual(['audit:view', 'server:view']);
  });

  it('rejects revoked tokens (401 unauthenticated on RBAC-gated route)', async () => {
    const { id, plaintext } = await mintToken(h, cookie, ['server:view']);
    await h.db
      .update(playerApiTokens)
      .set({ revokedAt: new Date() })
      .where(eq(playerApiTokens.id, id));

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('updates last_used_at on first use', async () => {
    const { id, plaintext } = await mintToken(h, cookie, ['server:view']);
    let stored = await h.db
      .select({ lastUsedAt: playerApiTokens.lastUsedAt })
      .from(playerApiTokens)
      .where(eq(playerApiTokens.id, id));
    expect(stored[0]?.lastUsedAt).toBeNull();

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(200);

    stored = await h.db
      .select({ lastUsedAt: playerApiTokens.lastUsedAt })
      .from(playerApiTokens)
      .where(eq(playerApiTokens.id, id));
    expect(stored[0]?.lastUsedAt).not.toBeNull();
  });

  it('cookie wins when both cookie and Bearer are present', async () => {
    const { plaintext } = await mintToken(h, cookie, []);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie, authorization: `Bearer ${plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { permissions: string[] };
    // Owner has many perms via cookie; Bearer with empty scopes would yield 0.
    expect(body.permissions.length).toBeGreaterThan(5);
  });

  it('Bearer cannot manage tokens (POST /me/tokens requires session)', async () => {
    const { plaintext } = await mintToken(h, cookie, ['user:manage_roles']);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { authorization: `Bearer ${plaintext}` },
      payload: { name: 'nested', scopes: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('garbage Bearer header is ignored', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/servers',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});
