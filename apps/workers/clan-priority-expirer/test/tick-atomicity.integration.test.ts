import { randomInt, randomUUID } from 'node:crypto';
import { auditLog, clanMembers, clans, createDatabaseClient, players } from '@squad/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClanPriorityExpiryDeps, runClanPriorityExpiryTick } from '../src/tick.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;
const diag = { emit: async () => undefined };
const NOW = new Date('2026-07-14T10:00:00.000Z');

function database() {
  if (!db) throw new Error('database not configured');
  return db;
}

let clanId: string;
let playerId: string;

beforeEach(async () => {
  if (!db) return;
  clanId = randomUUID();
  playerId = randomUUID();
  const name = `Expiry-${clanId.slice(0, 8)}`;
  await db.insert(players).values({
    id: playerId,
    // A test-only range far from real SteamID64s.
    steamId64: 76561190900000000n + BigInt(randomInt(1, 1_000_000)),
    canonicalName: name,
    canonicalNameNormalized: name.toLowerCase(),
  });
  await db.insert(clans).values({
    id: clanId,
    name,
    priorityExpiresAt: new Date('2026-07-14T09:00:00.000Z'),
  });
  await db
    .insert(clanMembers)
    .values({ clanId, playerId, memberRole: 'leader', hasPriority: true });
});

afterEach(async () => {
  if (!db) return;
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS test_fail_clan_expiry_audit ON audit_log'));
  await db.delete(clans).where(eq(clans.id, clanId));
  await db.delete(players).where(eq(players.id, playerId));
});

afterAll(async () => {
  await db?.execute(sql.raw('DROP FUNCTION IF EXISTS test_fail_clan_expiry_audit()'));
  await db?.$client.end();
});

async function clanState() {
  const [row] = await database()
    .select({ processed: clans.priorityExpiryProcessed })
    .from(clans)
    .where(eq(clans.id, clanId));
  const audits = await database()
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.actionType, 'clan.priority.expire'), eq(auditLog.targetId, clanId)));
  return { processed: row?.processed, audits: audits.length };
}

describeIfDb('clan priority expiry atomicity', () => {
  it('marks the clan processed together with its audit row', async () => {
    await runClanPriorityExpiryTick({
      ...createClanPriorityExpiryDeps(database()),
      diag,
      now: NOW,
    });

    expect(await clanState()).toEqual({ processed: true, audits: 1 });
  });

  it('leaves the clan unprocessed when its audit row cannot be written (#866)', async () => {
    await database().execute(
      sql.raw(`CREATE OR REPLACE FUNCTION test_fail_clan_expiry_audit() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit write failed'; END $$`),
    );
    await database().execute(
      sql.raw(`CREATE TRIGGER test_fail_clan_expiry_audit BEFORE INSERT ON audit_log
        FOR EACH ROW WHEN (NEW.target_id = '${clanId}')
        EXECUTE FUNCTION test_fail_clan_expiry_audit()`),
    );

    await expect(
      runClanPriorityExpiryTick({ ...createClanPriorityExpiryDeps(database()), diag, now: NOW }),
    ).rejects.toThrow();

    expect(await clanState()).toEqual({ processed: false, audits: 0 });
  });

  it('does not re-mark a clan whose priority was extended after it was selected (#865)', async () => {
    const deps = createClanPriorityExpiryDeps(database());
    const extendedUntil = new Date('2026-08-14T09:00:00.000Z');

    await runClanPriorityExpiryTick({
      ...deps,
      diag,
      now: NOW,
      findExpiredUnprocessedClans: async (now) => {
        const found = await deps.findExpiredUnprocessedClans(now);
        // PATCH /api/v1/clans/:id/expire lands between the select and the update.
        await database()
          .update(clans)
          .set({ priorityExpiresAt: extendedUntil, priorityExpiryProcessed: false })
          .where(eq(clans.id, clanId));
        return found;
      },
    });

    expect(await clanState()).toEqual({ processed: false, audits: 0 });
  });
});
