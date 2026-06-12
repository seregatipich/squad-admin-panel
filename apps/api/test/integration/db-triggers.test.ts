import { auditLog, configVersions } from '@squad/db/schema';
import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIntegrationApp, type IntegrationHarness } from './harness.js';

/**
 * Drizzle wraps postgres errors with `Failed query: …` at the top level and
 * hangs the real Postgres error off `err.cause`. This helper walks the cause
 * chain so the test can match on any layer.
 */
async function expectRejectsMatching(promise: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const msgs: string[] = [];
    let current: unknown = err;
    while (current instanceof Error) {
      msgs.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    if (msgs.some((m) => re.test(m))) return;
    throw new Error(`no error in chain matched ${re}; saw: ${msgs.join(' | ')}`);
  }
  throw new Error(`expected promise to reject matching ${re}, but it resolved`);
}

let h: IntegrationHarness;

beforeEach(async () => {
  h = await buildIntegrationApp();
});

afterEach(async () => {
  await h.cleanup();
});

describe('audit_log trigger invariants', () => {
  it('UPDATE raises "audit_log is append-only"', async () => {
    await h.db.insert(auditLog).values({
      actorPlayerId: null,
      actorKind: 'system',
      actorSystemLabel: 'test',
      actionType: 'x.test',
      targetType: null,
      targetId: null,
      context: {},
      rowHash: Buffer.from([]),
    });
    const [row] = await h.db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(1);
    await expectRejectsMatching(
      h.db.update(auditLog).set({ actionType: 'tampered' }).where(eq(auditLog.id, row?.id)),
      /append-only/i,
    );
  });

  it('DELETE raises "audit_log is append-only"', async () => {
    await h.db.insert(auditLog).values({
      actorPlayerId: null,
      actorKind: 'system',
      actorSystemLabel: 'test',
      actionType: 'x.test',
      targetType: null,
      targetId: null,
      context: {},
      rowHash: Buffer.from([]),
    });
    await expectRejectsMatching(h.db.delete(auditLog), /append-only/i);
  });

  it('row_hash is a 32-byte sha256 digest and chains across inserts', async () => {
    for (let i = 0; i < 3; i++) {
      await h.db.insert(auditLog).values({
        actorPlayerId: null,
        actorKind: 'system',
        actorSystemLabel: 'test',
        actionType: `chain.${i}`,
        targetType: null,
        targetId: null,
        context: { seq: i },
        rowHash: Buffer.from([]),
      });
    }
    const rows = await h.db.select().from(auditLog).orderBy(auditLog.id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Buffer.from(row.rowHash as unknown as Buffer).byteLength).toBe(32);
    }
    expect(rows[0]?.prevHash).toBeNull();
    expect(
      Buffer.from(rows[1]?.prevHash as unknown as Buffer).equals(
        rows[0]?.rowHash as unknown as Buffer,
      ),
    ).toBe(true);
    expect(
      Buffer.from(rows[2]?.prevHash as unknown as Buffer).equals(
        rows[1]?.rowHash as unknown as Buffer,
      ),
    ).toBe(true);
  });
});

describe('config_versions trigger invariants', () => {
  it('rejects UPDATE and DELETE', async () => {
    // Seed a server directly via Drizzle so FK for config_versions holds.
    const { servers } = await import('@squad/db/schema');
    await h.db.insert(servers).values({
      id: '019e0000-0000-7000-8000-000000000001',
      displayName: 'Trigger Test',
      slug: 'trigger-test',
    });
    await h.db.insert(configVersions).values({
      serverId: '019e0000-0000-7000-8000-000000000001',
      filename: 'Admins.cfg',
      content: 'original',
      sha256: Buffer.alloc(32, 0x11),
      authorLabel: 'system',
    });
    const [row] = await h.db.select().from(configVersions);
    await expectRejectsMatching(
      h.db
        .update(configVersions)
        .set({ content: 'tampered' })
        .where(eq(configVersions.id, row?.id)),
      /append-only|immutable|cannot/i,
    );
    await expectRejectsMatching(h.db.delete(configVersions), /append-only|immutable|cannot/i);
  });
});
