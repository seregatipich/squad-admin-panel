import { describe, expect, it } from 'vitest';

const BASE_URL = process.env.PANEL_TEST_URL;
const COOKIE = process.env.PANEL_TEST_COOKIE;
const SECONDARY_STEAM_ID = process.env.PANEL_E2E_SECONDARY_STEAM_ID;

const fetchOwner = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...init.headers, cookie: `__Host-sid=${COOKIE}` },
  });

describe.skipIf(!BASE_URL || !COOKIE || !SECONDARY_STEAM_ID)('panel RBAC e2e', () => {
  it('full lifecycle: create role → assign → modify → revoke', async () => {
    let res = await fetchOwner('/api/v1/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `E2E_${Date.now()}`,
        color: 'blue',
        permissions: ['server:view'],
      }),
    });
    expect(res.status).toBe(201);
    const role = (await res.json()) as { id: string };

    try {
      res = await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: role.id }),
      });
      expect(res.status).toBe(200);

      res = await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`);
      expect(res.status).toBe(200);
      const assigned = (await res.json()) as { role: { id: string } | null };
      expect(assigned.role?.id).toBe(role.id);

      res = await fetchOwner(`/api/v1/roles/${role.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: [] }),
      });
      expect(res.status).toBe(200);

      res = await fetchOwner(`/api/v1/roles/${role.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);

      res = await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`);
      const after = (await res.json()) as { role: null };
      expect(after.role).toBeNull();
    } finally {
      await fetchOwner(`/api/v1/roles/${role.id}`, { method: 'DELETE' }).catch(() => {});
      await fetchOwner(`/api/v1/players/${SECONDARY_STEAM_ID}/role`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role_id: null }),
      }).catch(() => {});
    }
  });

  it('Owner-lockout: cannot remove last Owner', async () => {
    const meRes = await fetchOwner('/api/v1/me');
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { steam_id64: string };

    const res = await fetchOwner(`/api/v1/players/${me.steam_id64}/role`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: null }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('cannot_remove_last_owner');
  });
});
