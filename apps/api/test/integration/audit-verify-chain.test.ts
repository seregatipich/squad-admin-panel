import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness, loginAsOwner } from './harness.js';

let h: IntegrationHarness;
let cookie: string;

/** Inserts one audit row through the append trigger and returns its id. */
async function insertAuditRow(
  action: string,
  targetType: string | null,
  targetId: string | null,
  context: Record<string, unknown>,
): Promise<string> {
  const rows = (await h.db.execute(sql`
    INSERT INTO audit_log
      (actor_kind, actor_system_label, actor_player_id, action_type,
       target_type, target_id, context, row_hash)
    VALUES (
      'system', 'test-verify-chain', NULL, ${action},
      ${targetType}, ${targetId}, ${JSON.stringify(context)}::jsonb, ''::bytea
    )
    RETURNING id::text AS id
  `)) as unknown as Array<{ id: string }>;
  // A single-row INSERT ... RETURNING always yields exactly one row.
  const row = rows[0] as { id: string };
  return row.id;
}

async function auditRowCount(): Promise<number> {
  const rows = (await h.db.execute(
    sql`SELECT count(*)::int AS n FROM audit_log`,
  )) as unknown as Array<{ n: number }>;
  // SELECT count(*) always yields exactly one row.
  const row = rows[0] as { n: number };
  return row.n;
}

interface VerifyResult {
  ok: boolean;
  checked: number;
  broken_at: string | null;
  reason: 'prev_hash' | 'row_hash' | null;
}

beforeEach(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: 76561198000000612n } });
  cookie = await loginAsOwner(h);
});

afterEach(async () => {
  await h.cleanup();
});

describe('GET /api/v1/audit/verify-chain', () => {
  it('requires authentication', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/audit/verify-chain' });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('reports an intact chain as ok', async () => {
    for (let i = 0; i < 5; i++) {
      await insertAuditRow(`action.${i}`, i % 2 === 0 ? 'server' : null, null, { seq: i });
    }
    const total = await auditRowCount();

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit/verify-chain',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as VerifyResult;
    expect(body.ok).toBe(true);
    expect(body.broken_at).toBeNull();
    expect(body.reason).toBeNull();
    expect(body.checked).toBe(total);
  });

  it('exposes a 64-hex row_hash on the audit list', async () => {
    await insertAuditRow('action.hash', 'server', 'srv-1', { seq: 0 });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit?page=1&page_size=50',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ row_hash: string; prev_hash: string | null }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]?.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects a tampered row and reports the break at the right id', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await insertAuditRow(`action.${i}`, null, null, { seq: i }));
    }
    // The loop above pushed 5 ids; index 2 is always populated.
    const tamperedId = ids[2] as string;

    // Simulate a superuser editing a stored row directly, bypassing the
    // append-only deny trigger (which normally blocks UPDATE/DELETE).
    await h.db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_upd`);
    await h.db.execute(sql`
      UPDATE audit_log
         SET context = ${JSON.stringify({ seq: 2, tampered: true })}::jsonb
       WHERE id = ${tamperedId}::bigint
    `);
    await h.db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_upd`);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit/verify-chain',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as VerifyResult;
    expect(body.ok).toBe(false);
    expect(body.broken_at).toBe(tamperedId);
    expect(body.reason).toBe('row_hash');
  });
});
