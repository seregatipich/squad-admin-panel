import { userRoleAssignments } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAuditRow,
  buildIntegrationApp,
  type IntegrationHarness,
  makeFakeBridge,
} from './integration/harness.js';

const EMAIL = 'owner@test.local';
const PASSWORD = 'correct-horse-battery-staple';

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp({
    seedOwner: { email: EMAIL, password: PASSWORD },
    bridge: makeFakeBridge(),
  });
});

afterEach(async () => {
  await h.cleanup();
});

async function login(): Promise<string> {
  const resp = await h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  if (resp.statusCode !== 200) throw new Error(`login failed: ${resp.body}`);
  const raw = Array.isArray(resp.headers['set-cookie'])
    ? resp.headers['set-cookie'][0]!
    : (resp.headers['set-cookie'] as string);
  return raw.match(/(__Host-sid=[^;]+)/)?.[1]!;
}

describe('POST /api/v1/host/restart', () => {
  it('Owner with host:bridge_control permission triggers a restart and writes an audit row', async () => {
    let calls = 0;
    h.bridge.hostAgentRestart = async () => {
      calls++;
      return { status: 'restarting' as const };
    };
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/restart',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'restarting' });
    expect(calls).toBe(1);
    await assertAuditRow(h, { action: 'host.bridge.restart', resource: 'host' });
  });

  it('viewer without host:bridge_control permission is rejected with 403', async () => {
    await login();
    const viewerRole = await h.db.query.roles.findFirst({
      where: (r, { and, eq: e }) => and(e(r.orgId, h.seed.orgId!), e(r.name, 'Viewer')),
    });
    if (!viewerRole || !h.seed.ownerUserId) throw new Error('viewer role missing');
    await h.db
      .delete(userRoleAssignments)
      .where(eq(userRoleAssignments.userId, h.seed.ownerUserId));
    await h.db
      .insert(userRoleAssignments)
      .values({ userId: h.seed.ownerUserId, roleId: viewerRole.id });

    const cookie = await login();
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/restart',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(403);
  });

  it('treats connection-reset from the bridge as success because the side-effect already happened', async () => {
    h.bridge.hostAgentRestart = async () => {
      throw new Error('socket closed');
    };
    const cookie = await login();
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/v1/host/restart',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.json()).toEqual({ status: 'restarting' });
  });
});
