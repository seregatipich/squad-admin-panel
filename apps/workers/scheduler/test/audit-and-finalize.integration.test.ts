import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { auditLog, createDatabaseClient, seasons } from '@squad/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { finalizeSeason, recomputeSeasonSlice, writeSystemAuditEntry } from '../src/deps.js';

const DATABASE_URL = process.env.DATABASE_URL;
const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;

const seasonId = randomUUID();
const auditTargetId = randomUUID();

afterAll(async () => {
  if (!db) return;
  await db.delete(seasons).where(eq(seasons.id, seasonId));
  await db.$client.end();
});

describe('scheduler audit writers (#1012)', () => {
  it('keeps a single audit_log insert in the scheduler sources so a schema change is made once', () => {
    const srcDir = new URL('../src/', import.meta.url);
    const sources = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .map((file) => ({ file, text: readFileSync(new URL(file, srcDir), 'utf8') }));
    const inserts = sources.flatMap(({ file, text }) =>
      (text.match(/insert\(auditLog\)/g) ?? []).map(() => file),
    );
    expect(inserts).toEqual(['deps/shared.ts']);
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

describeIfDb('recomputeSeasonSlice (#1110)', () => {
  const sliceSeasonId = randomUUID();
  const playerId = randomUUID();
  const serverId = randomUUID();
  const periodStart = '2031-03-01';

  afterAll(async () => {
    if (!db) return;
    await db.execute(sql`DELETE FROM player_stat_periods WHERE player_id = ${playerId}`);
    await db.execute(sql`DELETE FROM player_daily_presence WHERE player_id = ${playerId}`);
    await db.execute(sql`DELETE FROM servers WHERE id = ${serverId}`);
    await db.execute(sql`DELETE FROM players WHERE id = ${playerId}`);
    await db.delete(seasons).where(eq(seasons.id, sliceSeasonId));
  });

  it('counts the last day before an exclusive midnight ends_at and ignores the day it names', async () => {
    if (!db) throw new Error('database not configured');
    await db.insert(seasons).values({
      id: sliceSeasonId,
      name: `slice-${sliceSeasonId}`,
      startsAt: new Date(`${periodStart}T00:00:00.000Z`),
      endsAt: new Date('2031-03-03T00:00:00.000Z'),
      status: 'active',
    });
    await db.execute(
      sql`INSERT INTO players (id, canonical_name, canonical_name_normalized)
          VALUES (${playerId}, ${`w7-${playerId}`}, ${`w7-${playerId}`})`,
    );
    await db.execute(
      sql`INSERT INTO servers (id, display_name, slug) VALUES (${serverId}, 'w7', ${`w7-${serverId}`})`,
    );
    for (const [day, seconds] of [
      ['2031-03-01', 100],
      ['2031-03-02', 200],
      ['2031-03-03', 400],
    ] as const) {
      await db.execute(
        sql`INSERT INTO player_daily_presence (player_id, server_id, day, online_seconds)
            VALUES (${playerId}, ${serverId}, ${day}::date, ${seconds})`,
      );
    }

    await recomputeSeasonSlice(db, sliceSeasonId);

    const rows = await db.execute(
      sql`SELECT online_seconds FROM player_stat_periods
          WHERE period_type = 'season' AND period_start = ${periodStart}::date
            AND player_id = ${playerId} AND server_id IS NULL`,
    );
    expect(Number((rows as unknown as { online_seconds: number }[])[0]?.online_seconds)).toBe(300);
  });
});
