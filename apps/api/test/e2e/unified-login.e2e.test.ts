/**
 * Unified SSO session smoke against the live panel stack.
 *
 * The cookie is obtained through bss.games and supplied via
 * PANEL_TEST_COOKIE. This suite verifies the resulting panel session and
 * that removed direct-login surfaces stay closed.
 *
 * Setup:
 *   1. docker compose up -d
 *   2. Open https://<host>/login and complete the BSS login.
 *   3. Copy __Host-sid value from devtools and export PANEL_TEST_COOKIE.
 *
 * Run: pnpm --filter @squad/api test:e2e
 */
import { describe, expect, it } from 'vitest';
import { newClient, shouldSkip } from './lib/client.js';

const skip = shouldSkip();

describe.skipIf(skip.skip)('unified-login e2e', () => {
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

  it('legacy POST /api/v1/setup/init returns 404', async () => {
    const res = await api.fetch('/api/v1/setup/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'attempt' }),
    });
    expect(res.status).toBe(404);
  });

  it('removed direct Steam login stays gone', async () => {
    const res = await api.fetch('/api/v1/auth/steam/login', { redirect: 'manual' });
    expect(res.status).toBe(404);
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
