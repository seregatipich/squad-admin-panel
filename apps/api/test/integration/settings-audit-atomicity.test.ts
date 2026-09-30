import { altDetectionSettings, altIgnoredIps, economySettings } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { testSteamId } from '../helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
  makeFakeBridge,
} from './harness.js';

const auditControl = vi.hoisted(() => ({ failNext: false }));

// Makes the audit insert fail on demand, to prove the audited change rolls back with it.
vi.mock('../../src/lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/audit.js')>();
  return {
    ...actual,
    writeAuditEntry: async (...args: Parameters<typeof actual.writeAuditEntry>) => {
      if (auditControl.failNext) throw new Error('audit insert failed');
      return actual.writeAuditEntry(...args);
    },
  };
});

const OWNER_STEAM = testSteamId(820101);

let h: IntegrationHarness;

beforeAll(async () => {
  h = await buildIntegrationApp({
    seedOwner: { steamId64: OWNER_STEAM },
    bridge: makeFakeBridge(),
  });
});

afterAll(async () => {
  await h.cleanup();
});

afterEach(async () => {
  auditControl.failNext = false;
  await h.db.delete(altIgnoredIps);
  await h.db.delete(altDetectionSettings);
  await h.db.insert(altDetectionSettings).values({ id: 1 });
});

describe('settings mutations are atomic with their audit row (#341, #348)', () => {
  it('rolls back the alt-detection settings update when the audit insert fails', async () => {
    const cookie = await loginAsOwner(h);
    auditControl.failNext = true;
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/alt-detection',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ weight_shared_ip: 777 }),
    });
    expect(res.statusCode).toBe(500);
    const [row] = await h.db
      .select()
      .from(altDetectionSettings)
      .where(eq(altDetectionSettings.id, 1));
    expect(row?.weightSharedIp).not.toBe(777);
  });

  it('rolls back the ignored-ip create when the audit insert fails', async () => {
    const cookie = await loginAsOwner(h);
    auditControl.failNext = true;
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/settings/alt-detection/ignored-ips',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ cidr: '203.0.113.0/24' }),
    });
    expect(res.statusCode).toBe(500);
    expect(await h.db.select().from(altIgnoredIps)).toHaveLength(0);
  });

  it('rolls back the ignored-ip delete when the audit insert fails', async () => {
    const cookie = await loginAsOwner(h);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/settings/alt-detection/ignored-ips',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ cidr: '203.0.113.0/24' }),
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    auditControl.failNext = true;
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/settings/alt-detection/ignored-ips/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(500);
    expect(await h.db.select().from(altIgnoredIps)).toHaveLength(1);
  });

  it('rolls back the economy settings update when the audit insert fails', async () => {
    const cookie = await loginAsOwner(h);
    const [before] = await h.db.select().from(economySettings).where(eq(economySettings.id, 1));
    auditControl.failNext = true;
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/economy',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ k_online: 123 }),
    });
    expect(res.statusCode).toBe(500);
    const [after] = await h.db.select().from(economySettings).where(eq(economySettings.id, 1));
    expect(after?.kOnline).toBe(before?.kOnline);
    expect(after?.kOnline).not.toBe(123);
  });
});
