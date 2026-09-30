import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_VERIFY_LOCK_KEY } from '../../src/routes/audit.js';
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
  reason: 'prev_hash' | 'row_hash' | 'anchor' | null;
  head: { id: string; row_hash: string } | null;
}

beforeAll(async () => {
  h = await buildIntegrationApp({ seedOwner: { steamId64: 76561198000000612n } });
  cookie = await loginAsOwner(h);
});

afterAll(async () => {
  await h?.cleanup();
});

/**
 * Rewrites a stored row's context with the append-only deny trigger switched
 * off, the way a superuser editing the table directly would.
 */
async function overwriteContext(id: string, context: Record<string, unknown>): Promise<void> {
  await h.db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_upd`);
  try {
    await h.db.execute(sql`
      UPDATE audit_log
         SET context = ${JSON.stringify(context)}::jsonb
       WHERE id = ${id}::bigint
    `);
  } finally {
    await h.db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_upd`);
  }
}

/**
 * Rewrites columns of a stored row with the append-only deny trigger off.
 * `assignments` is trusted test SQL (column = literal pairs).
 */
async function overwriteColumns(id: string, assignments: string): Promise<void> {
  await h.db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_upd`);
  try {
    await h.db.execute(sql`UPDATE audit_log SET ${sql.raw(assignments)} WHERE id = ${id}::bigint`);
  } finally {
    await h.db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_upd`);
  }
}

async function verifyChain(): Promise<VerifyResult> {
  const res = await h.app.inject({
    method: 'GET',
    url: '/api/v1/audit/verify-chain',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as VerifyResult;
}

describe('GET /api/v1/audit/verify-chain', () => {
  it('stays intact when a row is written from a session with another TimeZone and DateStyle', async () => {
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TimeZone = 'America/New_York'`);
      await tx.execute(sql`SET LOCAL DateStyle = 'SQL, DMY'`);
      await tx.execute(sql`
        INSERT INTO audit_log (actor_kind, actor_system_label, action_type, row_hash)
        VALUES ('system', 'test-verify-chain', 'action.timezone', ''::bytea)
      `);
    });

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit/verify-chain',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, broken_at: null });
  });

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

  it('reports the total row count, not the page size (#94)', async () => {
    await insertAuditRow('action.total', 'server', 'srv-1', { seq: 1 });
    await insertAuditRow('action.total', 'server', 'srv-1', { seq: 2 });
    const expected = await auditRowCount();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit?page=2&page_size=1',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number; page: number };
    expect(body.items).toHaveLength(1);
    expect(body.page).toBe(2);
    expect(body.total).toBe(expected);
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
    await overwriteContext(tamperedId, { seq: 2, tampered: true });
    try {
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
    } finally {
      // The file's tests share one chain, so restore the exact context the
      // stored row_hash was computed over; later tests expect it intact.
      await overwriteContext(tamperedId, { seq: 2 });
    }
  });

  it('stays intact when a later id takes the append lock first (#36 finding 16)', async () => {
    // Connection B takes the chain lock the trigger uses, so A's INSERT — whose
    // bigserial id is drawn before its trigger runs — blocks with the smaller
    // id while B inserts a larger one and commits first. Before the fix the id
    // order then diverged from the chain order and verification reported a
    // prev_hash break on an untouched table.
    const connA = postgres(h.url, { max: 1, onnotice: () => undefined });
    const connB = postgres(h.url, { max: 1, onnotice: () => undefined });
    try {
      let insertA: Promise<unknown> | undefined;
      await connB.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended('audit_log', 0))`;
        insertA = connA`
          INSERT INTO audit_log (actor_kind, actor_system_label, action_type, context, row_hash)
          VALUES ('system', 'test-verify-chain', 'race.a', '{}'::jsonb, ''::bytea)`.execute();
        await waitForBlockedAdvisoryLock();
        await tx`
          INSERT INTO audit_log (actor_kind, actor_system_label, action_type, context, row_hash)
          VALUES ('system', 'test-verify-chain', 'race.b', '{}'::jsonb, ''::bytea)`;
      });
      await insertA;
    } finally {
      await connA.end({ timeout: 5 });
      await connB.end({ timeout: 5 });
    }

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit/verify-chain',
      headers: { cookie },
    });
    expect(res.json()).toMatchObject({ ok: true, broken_at: null, reason: null });
  });

  it('stays intact for rows written by a session in another TimeZone (#36 finding 16)', async () => {
    const tokyo = postgres(h.url, {
      max: 1,
      onnotice: () => undefined,
      connection: { TimeZone: 'Asia/Tokyo' },
    });
    try {
      await tokyo`
        INSERT INTO audit_log (actor_kind, actor_system_label, action_type, context, row_hash)
        VALUES ('system', 'test-verify-chain', 'tz.tokyo', '{}'::jsonb, ''::bytea)`;
    } finally {
      await tokyo.end({ timeout: 5 });
    }
    await insertAuditRow('tz.after', null, null, {});

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit/verify-chain',
      headers: { cookie },
    });
    expect(res.json()).toMatchObject({ ok: true, broken_at: null, reason: null });
  });

  it('refuses a second verification while one is running (#36 finding 17)', async () => {
    await h.redis.set(AUDIT_VERIFY_LOCK_KEY, 'other-run', 'PX', 60_000);
    try {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/audit/verify-chain',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'verify_in_progress' });
    } finally {
      await h.redis.del(AUDIT_VERIFY_LOCK_KEY);
    }
    const again = await h.app.inject({
      method: 'GET',
      url: '/api/v1/audit/verify-chain',
      headers: { cookie },
    });
    expect(again.statusCode).toBe(200);
    expect(await h.redis.get(AUDIT_VERIFY_LOCK_KEY)).toBeNull();
  });

  // Issue #50 (#1251/#1064): the v1 canonical form ignored the actor and the
  // snapshots, so rewriting who did something went unnoticed.
  it('detects a rewritten actor label on a stored row', async () => {
    const id = await insertAuditRow('action.actor', 'server', 'srv-actor', { seq: 'actor' });
    await overwriteColumns(id, "actor_system_label = 'someone-else'");
    try {
      const body = await verifyChain();
      expect(body.ok).toBe(false);
      expect(body.broken_at).toBe(id);
      expect(body.reason).toBe('row_hash');
    } finally {
      await overwriteColumns(id, "actor_system_label = 'test-verify-chain'");
    }
  });

  it('detects a rewritten after_snapshot on a stored row', async () => {
    const id = await insertAuditRow('action.snapshot', 'server', 'srv-snap', { seq: 'snap' });
    await overwriteColumns(id, `after_snapshot = '{"forged": true}'::jsonb`);
    try {
      const body = await verifyChain();
      expect(body.ok).toBe(false);
      expect(body.broken_at).toBe(id);
      expect(body.reason).toBe('row_hash');
    } finally {
      await overwriteColumns(id, 'after_snapshot = NULL');
    }
    expect((await verifyChain()).ok).toBe(true);
  });

  describe('external anchor (#1064)', () => {
    async function verifyAgainst(query: string) {
      return h.app.inject({
        method: 'GET',
        url: `/api/v1/audit/verify-chain${query}`,
        headers: { cookie },
      });
    }

    it('reports the chain head, and accepts it as an anchor later', async () => {
      const id = await insertAuditRow('action.anchor.head', null, null, { seq: 'head' });
      const { head } = await verifyChain();
      expect(head?.id).toBe(id);
      expect(head?.row_hash).toMatch(/^[0-9a-f]{64}$/);

      await insertAuditRow('action.anchor.after', null, null, { seq: 'after' });
      const res = await verifyAgainst(`?anchor_id=${id}&anchor_hash=${head?.row_hash}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, broken_at: null, reason: null });
    });

    it('rejects an anchor that names only one of id and hash', async () => {
      expect((await verifyAgainst('?anchor_id=1')).statusCode).toBe(400);
      expect((await verifyAgainst(`?anchor_hash=${'a'.repeat(64)}`)).statusCode).toBe(400);
      expect((await verifyAgainst('?anchor_id=1&anchor_hash=zz')).statusCode).toBe(400);
    });

    it('detects an anchored row whose hash differs', async () => {
      const id = await insertAuditRow('action.anchor.forged', null, null, { seq: 'forged' });
      const res = await verifyAgainst(`?anchor_id=${id}&anchor_hash=${'0'.repeat(64)}`);
      expect(res.json()).toMatchObject({ ok: false, broken_at: id, reason: 'anchor' });
    });

    it('detects a truncated tail that leaves the remaining chain self-consistent', async () => {
      await insertAuditRow('action.anchor.kept', null, null, { seq: 'kept' });
      const tailId = await insertAuditRow('action.anchor.tail', null, null, { seq: 'tail' });
      const { head } = await verifyChain();
      expect(head?.id).toBe(tailId);

      await h.db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_del`);
      try {
        await h.db.execute(sql`DELETE FROM audit_log WHERE id = ${tailId}::bigint`);
      } finally {
        await h.db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_del`);
      }

      expect((await verifyChain()).ok).toBe(true);
      const res = await verifyAgainst(`?anchor_id=${tailId}&anchor_hash=${head?.row_hash}`);
      expect(res.json()).toMatchObject({ ok: false, broken_at: tailId, reason: 'anchor' });
    });
  });
});

/** Resolves once some backend is queued on the audit chain's advisory lock. */
async function waitForBlockedAdvisoryLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = (await h.db.execute(sql`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `)) as unknown as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the concurrent INSERT never queued on the audit_log lock');
}
