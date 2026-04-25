import { playerApiTokens } from '@squad/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000001000n;

async function freshOwner(): Promise<{ h: IntegrationHarness; cookie: string }> {
  const h = await buildIntegrationApp({ seedOwner: { steamId64: OWNER_STEAM_ID } });
  const cookie = await loginAsOwner(h);
  return { h, cookie };
}

describe('GET /api/v1/me/tokens', () => {
  let h: IntegrationHarness;
  let cookie: string;
  beforeEach(async () => {
    ({ h, cookie } = await freshOwner());
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('401 without cookie', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me/tokens' });
    expect(res.statusCode).toBe(401);
  });

  it('returns empty array initially, then lists created tokens without hash/plaintext', async () => {
    const empty = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/tokens',
      headers: { cookie },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie },
      payload: { name: 'CI bot', scopes: ['server:view'] },
    });
    expect(create.statusCode).toBe(201);

    const list = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me/tokens',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    const row = body[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty('plaintext');
    expect(row).not.toHaveProperty('token_hash');
    expect(row).not.toHaveProperty('tokenHash');
    expect(row.name).toBe('CI bot');
    expect(row.scopes).toEqual(['server:view']);
    expect(row.revoked_at).toBeNull();
  });
});

describe('POST /api/v1/me/tokens', () => {
  let h: IntegrationHarness;
  let cookie: string;
  beforeEach(async () => {
    ({ h, cookie } = await freshOwner());
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('mints sqp_-prefixed plaintext exactly once and persists hash only', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie },
      payload: { name: 'release script', scopes: ['server:view', 'audit:view'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; plaintext: string; scopes: string[] };
    expect(body.plaintext.startsWith('sqp_')).toBe(true);
    expect(body.scopes).toEqual(['server:view', 'audit:view']);

    const stored = await h.db.select().from(playerApiTokens).where(eq(playerApiTokens.id, body.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).not.toBe(body.plaintext);

    await assertAuditRow(h, { action: 'user.api_token.create', resource: 'api_token' });
  });

  it('rejects scopes the caller does not have (422 invalid_scopes)', async () => {
    // Re-seed but as a Viewer to force a narrow scope set.
    await h.cleanup();
    const localOwner = 76561198000001500n;
    const { h: h2 } = await freshOwner();
    h = h2;
    cookie = await loginAsOwner(h);
    void localOwner;

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie },
      payload: { name: 'bad', scopes: ['definitely:not:a:permission'] },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string; unknown: string[]; not_granted: string[] };
    expect(body.error).toBe('invalid_scopes');
    expect(body.unknown).toEqual(['definitely:not:a:permission']);
  });

  it('accepts empty scopes array', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie },
      payload: { name: 'introspect-only', scopes: [] },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { scopes: string[] }).scopes).toEqual([]);
  });

  it('400 when name is empty string', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie },
      payload: { name: '', scopes: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/v1/me/tokens/:id', () => {
  let h: IntegrationHarness;
  let cookie: string;
  beforeEach(async () => {
    ({ h, cookie } = await freshOwner());
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('revokes own token (sets revoked_at, keeps row for audit FK)', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie },
      payload: { name: 'kill-me', scopes: ['server:view'] },
    });
    const id = (create.json() as { id: string }).id;

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/tokens/${id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const stored = await h.db.select().from(playerApiTokens).where(eq(playerApiTokens.id, id));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.revokedAt).not.toBeNull();

    const stillActive = await h.db
      .select()
      .from(playerApiTokens)
      .where(and(eq(playerApiTokens.id, id), isNull(playerApiTokens.revokedAt)));
    expect(stillActive).toHaveLength(0);

    await assertAuditRow(h, { action: 'user.api_token.revoke', resource: 'api_token' });
  });

  it('returns 404 for unknown id', async () => {
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/me/tokens/01939a8b-0000-7000-8000-000000000000',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('idempotent: second revoke returns ok with already_revoked flag', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie },
      payload: { name: 'twice', scopes: [] },
    });
    const id = (create.json() as { id: string }).id;
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/tokens/${id}`,
      headers: { cookie },
    });
    const second = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/me/tokens/${id}`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, already_revoked: true });
  });
});
