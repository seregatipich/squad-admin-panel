import { players } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidatePermissionCache } from '../src/lib/rbac.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './integration/harness.js';

const OWNER_STEAM_ID = 76561198000000777n;

const SAMPLE_USAGE = {
  configs_bytes: 100,
  saved_total_bytes: 200,
  saved_per_server: [{ uuid: '019dbaa5-1111-2222-3333-444444444444', bytes: 200 }],
  depot_volume_bytes: 0,
  docker_volumes: [],
  docker_images: [],
  audit_archive_bytes: 0,
  total_panel_bytes: 300,
  host_total_bytes: 1000,
  host_used_bytes: 600,
  computed_at: '2026-04-28T10:00:00Z',
  cache_age_seconds: 0,
};

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM_ID },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  if (h.seed.ownerSteamId64) invalidatePermissionCache(h.seed.ownerPlayerId!);
  await h.cleanup();
});

describe('GET /api/v1/host/disk-usage', () => {
  it('returns the bridge payload plus derived panel_pct and other_pct', async () => {
    h.bridge.panelDiskUsage = async () => ({ ...SAMPLE_USAGE });
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/disk-usage',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json() as typeof SAMPLE_USAGE & {
      panel_pct: number;
      other_pct: number;
    };

    expect(body.configs_bytes).toBe(100);
    expect(body.saved_total_bytes).toBe(200);
    expect(body.saved_per_server).toEqual(SAMPLE_USAGE.saved_per_server);
    expect(body.depot_volume_bytes).toBe(0);
    expect(body.docker_volumes).toEqual([]);
    expect(body.docker_images).toEqual([]);
    expect(body.audit_archive_bytes).toBe(0);
    expect(body.total_panel_bytes).toBe(300);
    expect(body.host_total_bytes).toBe(1000);
    expect(body.host_used_bytes).toBe(600);
    expect(body.computed_at).toBe('2026-04-28T10:00:00Z');
    expect(body.cache_age_seconds).toBe(0);

    expect(body.panel_pct).toBeCloseTo(30.0);
    expect(body.other_pct).toBeCloseTo(30.0);
    expect(body.panel_pct + body.other_pct).toBeCloseTo(
      (SAMPLE_USAGE.host_used_bytes / SAMPLE_USAGE.host_total_bytes) * 100,
    );
  });

  it('returns panel_pct=0 and other_pct=0 when host_total_bytes is 0 (no NaN)', async () => {
    h.bridge.panelDiskUsage = async () => ({
      ...SAMPLE_USAGE,
      total_panel_bytes: 0,
      host_total_bytes: 0,
      host_used_bytes: 0,
    });
    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/disk-usage',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    const body = resp.json() as { panel_pct: number; other_pct: number };
    expect(body.panel_pct).toBe(0);
    expect(body.other_pct).toBe(0);
    expect(Number.isNaN(body.panel_pct)).toBe(false);
    expect(Number.isNaN(body.other_pct)).toBe(false);
  });

  it('returns 403 for a user without host:view (no role)', async () => {
    h.bridge.panelDiskUsage = async () => ({ ...SAMPLE_USAGE });
    if (!h.seed.ownerSteamId64) throw new Error('owner steam id missing');
    await h.db
      .update(players)
      .set({ roleId: null })
      .where(eq(players.steamId64, h.seed.ownerSteamId64));
    invalidatePermissionCache(h.seed.ownerPlayerId!);

    const cookie = await loginAsOwner(h);
    const resp = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/disk-usage',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
  });

  it('returns 401 without a session', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/api/v1/host/disk-usage' });
    expect(resp.statusCode).toBe(401);
  });

  it('passes { force: true } to bridge.panelDiskUsage when ?refresh=1', async () => {
    const calls: Array<{ force?: boolean } | undefined> = [];
    h.bridge.panelDiskUsage = async (opts) => {
      calls.push(opts);
      return { ...SAMPLE_USAGE };
    };
    const cookie = await loginAsOwner(h);

    const cached = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/disk-usage',
      headers: { cookie },
    });
    expect(cached.statusCode).toBe(200);

    const refreshed = await h.app.inject({
      method: 'GET',
      url: '/api/v1/host/disk-usage?refresh=1',
      headers: { cookie },
    });
    expect(refreshed.statusCode).toBe(200);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toEqual({ force: true });
  });
});
