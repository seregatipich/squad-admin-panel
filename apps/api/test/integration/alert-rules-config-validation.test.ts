import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateAllPermissionCaches } from '../../src/lib/rbac.js';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const OWNER_STEAM = testSteamId(944001);

let h: IntegrationHarness;
let ownerCookie: string;

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
  ownerCookie = await loginAsOwner(h);
}, 60_000);

afterAll(async () => {
  invalidateAllPermissionCaches();
  await h.cleanup();
}, 60_000);

async function createCustomRule(config: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/alert-rules',
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: `Rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'custom',
      config,
      channels: ['webpush'],
      enabled: true,
    }),
  });
}

// Regression for TZ #63 finding 912: an out-of-range config.severity used to
// pass validation here and only fail later, uncaught, at
// worker-log-ingest's alert_events_severity_chk insert, aborting external-ban
// enforcement for any later matches in the same connect event.
describeIfDb('alert-rules config.severity validation (regression, issue #63)', () => {
  it('rejects a custom rule whose config.severity is not in the alert_events_severity_chk allowlist', async () => {
    const res = await createCustomRule({
      eventKind: 'externalban.matched',
      severity: 'not-a-real-severity',
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a custom rule with a valid config.severity', async () => {
    const res = await createCustomRule({
      eventKind: 'externalban.matched',
      severity: 'critical',
    });
    expect(res.statusCode).toBe(201);
  });

  it('accepts a custom rule that omits config.severity', async () => {
    const res = await createCustomRule({ eventKind: 'externalban.matched' });
    expect(res.statusCode).toBe(201);
  });
});
