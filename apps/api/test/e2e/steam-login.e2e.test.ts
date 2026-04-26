/**
 * Steam-only login smoke against the live panel stack.
 *
 * Cannot exercise the OpenID 2.0 verifier itself without a real Steam
 * account; instead this test verifies that AFTER a manual Steam login
 * (cookie supplied via PANEL_TEST_COOKIE env), the panel reports the
 * caller correctly and the setup wizard is properly locked.
 *
 * Setup:
 *   1. docker compose up -d
 *   2. Open https://<host>/login, sign in via Steam (becomes Owner).
 *   3. Copy __Host-sid value from devtools and export PANEL_TEST_COOKIE.
 *
 * Run: pnpm --filter @squad/api test:e2e
 */
import { describe, expect, it } from 'vitest';
import { newClient, shouldSkip } from './lib/client.js';

const skip = shouldSkip();

describe.skipIf(skip.skip)('steam-login e2e', () => {
  const api = newClient();

  it('GET /api/v1/me returns the Owner with non-empty permissions', async () => {
    const me = await api.json<{
      steam_id64: string;
      canonical_name: string;
      permissions: string[];
    }>('/api/v1/me');
    expect(me.steam_id64).toMatch(/^\d{17}$/);
    expect(me.permissions.length).toBeGreaterThan(0);
    expect(me.permissions).toContain('user:manage_roles');
  });

  it('GET /api/v1/me/sessions lists at least the current session', async () => {
    const sessions =
      await api.json<
        Array<{
          id: string;
          ip: string | null;
          user_agent: string | null;
          last_activity_at: string;
          expires_at: string;
          current: boolean;
        }>
      >('/api/v1/me/sessions');
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s) => s.current)).toBe(true);
  });

  it('legacy POST /api/v1/setup/init returns 404 (setup wizard removed in Эпик 2)', async () => {
    const res = await api.fetch('/api/v1/setup/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'attempt' }),
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/v1/auth/steam/login redirects to steamcommunity.com', async () => {
    const res = await api.fetch('/api/v1/auth/steam/login', { redirect: 'manual' });
    expect([302, 303, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('steamcommunity.com/openid/login');
  });

  it('legacy /api/v1/auth/login is gone (404)', async () => {
    const res = await api.fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x', password: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});
