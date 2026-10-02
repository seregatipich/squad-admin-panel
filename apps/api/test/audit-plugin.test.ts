import { auditLog } from '@squad/db/schema';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testSteamId } from './helpers/snapshot-restore.js';
import {
  buildIntegrationApp,
  type IntegrationHarness,
  loginAsOwner,
} from './integration/harness.js';

// Regression for #37 finding #65: the audit onResponse hook wrote an
// append-only audit_log row for every anonymous request an auth hook
// rejected, storing the attacker-controlled URL (with query) and
// User-Agent verbatim.

let h: IntegrationHarness;

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: testSteamId(917_002) } });
});

afterAll(async () => {
  await h?.cleanup();
});

/** Audit rows the hook wrote for one request, found by the unique marker that starts its User-Agent. */
async function selectAuditRows(marker: string) {
  return h.db
    .select()
    .from(auditLog)
    .where(sql`${auditLog.context}->>'userAgent' LIKE ${`${marker}%`}`);
}

/** The hook writes after the response is sent, so this polls until a row for the marker appears. */
async function waitForAuditRows(marker: string) {
  return vi.waitFor(
    async () => {
      const rows = await selectAuditRows(marker);
      if (rows.length === 0) throw new Error(`no audit row for ${marker}`);
      return rows;
    },
    { timeout: 5_000, interval: 25 },
  );
}

describe('audit plugin', () => {
  it('writes no audit row for an anonymous request rejected with 401', async () => {
    const marker = `anon-${uuidv7()}`;
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles?junk=1',
      headers: { 'user-agent': `${marker}${'x'.repeat(4_000)}` },
      payload: { name: 'anon-probe' },
    });
    expect(res.statusCode).toBe(401);

    // Audit writes are serialised on the hash chain, so once a later audited
    // request has its row, the anonymous request's hook has already finished.
    const cookie = await loginAsOwner(h);
    const sentinel = `sentinel-${uuidv7()}`;
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { cookie, 'user-agent': sentinel },
      payload: {},
    });
    await waitForAuditRows(sentinel);

    expect(await selectAuditRows(marker)).toHaveLength(0);
  });

  it('stores the path without its query and caps the User-Agent length', async () => {
    const cookie = await loginAsOwner(h);
    const marker = `authed-${uuidv7()}`;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/roles?padding=${'q'.repeat(4_000)}`,
      headers: { cookie, 'user-agent': `${marker}${'u'.repeat(4_000)}` },
      // Invalid body: the route answers 400 without creating a role, but the
      // attempt is still audited.
      payload: {},
    });
    expect(res.statusCode).toBe(400);

    const [row] = await waitForAuditRows(marker);
    expect(row).toBeDefined();
    const context = row?.context as { url: string; userAgent: string };
    expect(context.url).toBe('/api/v1/roles');
    expect(context.userAgent.length).toBeLessThanOrEqual(512);
  });
});
