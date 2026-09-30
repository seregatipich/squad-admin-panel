import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auditLog, createDatabaseClient, seasons } from '@squad/db';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { finalizeSeason, writeSystemAuditEntry } from '../src/deps.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

const seasonId = randomUUID();
const auditTargetId = randomUUID();

afterAll(async () => {
  if (!db) return;
  await db.delete(seasons).where(eq(seasons.id, seasonId));
  await db.$client.end();
});

describe('scheduler audit writers (#1012)', () => {
  it('keeps a single audit_log insert in deps.ts so a schema change is made once', () => {
    const source = readFileSync(new URL('../src/deps.ts', import.meta.url), 'utf8');
    expect(source.match(/insert\(auditLog\)/g)).toHaveLength(1);
  });
});

describeIfDb('writeSystemAuditEntry (#1012)', () => {
  it('appends a system-actor audit_log row carrying the entry fields', async () => {
    if (!db) throw new Error('database not configured');
    await writeSystemAuditEntry(db, {
      actor: { kind: 'system', label: 'season-finalizer' },
      actionType: 'season.finalize',
      targetType: 'season',
      targetId: auditTargetId,
      context: { name: 'Test' },
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, auditTargetId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: 'system',
      actorSystemLabel: 'season-finalizer',
      actionType: 'season.finalize',
      targetType: 'season',
      context: { name: 'Test' },
    });
  });
});

describeIfDb('finalizeSeason atomicity (#1021)', () => {
  const audit = {
    actor: { kind: 'system' as const, label: 'season-finalizer' as const },
    actionType: 'season.finalize' as const,
    targetType: 'season' as const,
    targetId: seasonId,
  };

  it('rolls the season back to active when the audit write fails, so the next tick retries it', async () => {
    if (!db) throw new Error('database not configured');
    await db.insert(seasons).values({
      id: seasonId,
      name: `finalize-atomic-${seasonId}`,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      endsAt: new Date('2026-02-01T00:00:00.000Z'),
      status: 'active',
    });

    // BigInt cannot be serialised into the jsonb context column, so the insert throws.
    await expect(
      finalizeSeason(db, seasonId, { ...audit, context: { bad: 1n } }),
    ).rejects.toThrow();

    const [row] = await db.select().from(seasons).where(eq(seasons.id, seasonId));
    expect(row).toMatchObject({ status: 'active', finalized: false });
    const logged = await db.select().from(auditLog).where(eq(auditLog.targetId, seasonId));
    expect(logged).toHaveLength(0);
  });

  it('closes the season and appends its audit row together on success', async () => {
    if (!db) throw new Error('database not configured');
    await finalizeSeason(db, seasonId, { ...audit, context: { name: 'ok' } });

    const [row] = await db.select().from(seasons).where(eq(seasons.id, seasonId));
    expect(row).toMatchObject({ status: 'closed', finalized: true });
    const logged = await db.select().from(auditLog).where(eq(auditLog.targetId, seasonId));
    expect(logged).toHaveLength(1);
  });
});
