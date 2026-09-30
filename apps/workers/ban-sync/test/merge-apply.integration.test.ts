import { randomUUID } from 'node:crypto';
import { createDatabaseClient, type DatabaseClient } from '@squad/db';
import { externalBanSources, externalBans } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ParsedBan } from '../src/adapters/index.js';
import { applyMergePlan, type ExistingBanRow, planMerge } from '../src/merge.js';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

function ban(steamId64: string, overrides: Partial<ParsedBan> = {}): ParsedBan {
  return {
    steamId64,
    eosId: null,
    nickname: `nick-${steamId64}`,
    reason: 'cheating',
    adminName: null,
    issuedAt: null,
    expiresAt: null,
    raw: { line: steamId64 },
    ...overrides,
  };
}

describeIfDb('applyMergePlan against Postgres (#853, #854)', () => {
  let db: DatabaseClient;
  let sourceId: string;

  beforeAll(() => {
    db = createDatabaseClient(process.env.DATABASE_URL as string);
  });

  beforeEach(async () => {
    sourceId = randomUUID();
    await db.insert(externalBanSources).values({
      id: sourceId,
      name: `merge-test-${sourceId}`,
      url: 'https://bans.example.com/bans.cfg',
      format: 'squad_bans_cfg',
    });
  });

  afterAll(async () => {
    await db
      .delete(externalBanSources)
      .where(eq(externalBanSources.url, 'https://bans.example.com/bans.cfg'));
  });

  async function rows(): Promise<ExistingBanRow[]> {
    return (await db
      .select()
      .from(externalBans)
      .where(eq(externalBans.sourceId, sourceId))) as unknown as ExistingBanRow[];
  }

  it('inserts, batch-updates and revokes in one pass', async () => {
    await applyMergePlan(db, sourceId, planMerge([], [ban('1'), ban('2'), ban('3')]));

    const result = await applyMergePlan(
      db,
      sourceId,
      planMerge(await rows(), [ban('1', { reason: 'griefing' }), ban('2'), ban('4')]),
    );

    expect(result).toEqual({ added: 1, updated: 1, revoked: 1 });
    const byId = new Map((await rows()).map((row) => [row.steamId64, row]));
    expect(byId.get('1')?.reason).toBe('griefing');
    expect(byId.get('1')?.raw).toEqual({ line: '1' });
    expect(byId.get('2')?.revokedAt).toBeNull();
    expect(byId.get('3')?.revokedAt).toBeInstanceOf(Date);
    expect(byId.get('4')?.revokedAt).toBeNull();
  });

  it('clears revoked_at on a reappearing ban and keeps a null expiry', async () => {
    await applyMergePlan(db, sourceId, planMerge([], [ban('5', { expiresAt: new Date() })]));
    await applyMergePlan(db, sourceId, planMerge(await rows(), []));

    await applyMergePlan(db, sourceId, planMerge(await rows(), [ban('5')]));

    const [row] = await rows();
    expect(row?.revokedAt).toBeNull();
    expect(row?.expiresAt).toBeNull();
  });

  it('leaves no partial state when applying a plan fails midway', async () => {
    await applyMergePlan(db, sourceId, planMerge([], [ban('1')]));
    const plan = planMerge(await rows(), [
      // A raw payload Postgres cannot store as jsonb makes the update fail
      // after the insert of '2' already ran.
      ban('1', { reason: 'changed', raw: { bad: '\u0000' } }),
      ban('2'),
    ]);

    await expect(applyMergePlan(db, sourceId, plan)).rejects.toThrow();

    const after = await rows();
    expect(after.map((row) => row.steamId64)).toEqual(['1']);
    expect(after[0]?.reason).toBe('cheating');
  });

  it('does not fail when an overlapping sync already inserted the same ban', async () => {
    const plan = planMerge([], [ban('7')]);
    await applyMergePlan(db, sourceId, plan);

    await expect(applyMergePlan(db, sourceId, plan)).resolves.toEqual({
      added: 0,
      updated: 0,
      revoked: 0,
    });
    expect(await rows()).toHaveLength(1);
  });
});
