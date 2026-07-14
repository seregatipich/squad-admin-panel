import { setTimeout as sleep } from 'node:timers/promises';
import { bannedNameRules, createDatabaseClient } from '@squad/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BannedNameRuleCache } from '../src/banname/rules-cache.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the banname104 test database');

const db = createDatabaseClient(DATABASE_URL);

const RULE_A = uuidv7();
const RULE_B = uuidv7();
const RULE_INACTIVE = uuidv7();

afterEach(async () => {
  await db.delete(bannedNameRules).where(eq(bannedNameRules.id, RULE_A));
  await db.delete(bannedNameRules).where(eq(bannedNameRules.id, RULE_B));
  await db.delete(bannedNameRules).where(eq(bannedNameRules.id, RULE_INACTIVE));
});

beforeEach(async () => {
  await db.insert(bannedNameRules).values([
    {
      id: RULE_A,
      pattern: 'cheater',
      matchType: 'substring',
      action: 'kick',
      isActive: true,
    },
    {
      id: RULE_INACTIVE,
      pattern: 'disabledrule',
      matchType: 'substring',
      action: 'kick',
      isActive: false,
    },
  ]);
});

afterAll(async () => {
  await db.$client.end();
});

describe('BannedNameRuleCache', () => {
  it('loads only is_active rules', async () => {
    const cache = new BannedNameRuleCache(db);
    expect(await cache.match('ProCheater')).toMatchObject({ ruleId: RULE_A });
    expect(await cache.match('DisabledRuleUser')).toBeNull();
  });

  it('does not re-query the database within the TTL window', async () => {
    const selectSpy = vi.spyOn(db, 'select');
    const cache = new BannedNameRuleCache(db, 200);

    await cache.match('anything');
    expect(selectSpy).toHaveBeenCalledTimes(1);

    await cache.match('anything');
    expect(selectSpy).toHaveBeenCalledTimes(1);

    selectSpy.mockRestore();
  });

  it('re-queries the database once the TTL elapses', async () => {
    const selectSpy = vi.spyOn(db, 'select');
    const cache = new BannedNameRuleCache(db, 50);

    await cache.match('anything');
    expect(selectSpy).toHaveBeenCalledTimes(1);

    await sleep(60);
    await cache.match('anything');
    expect(selectSpy).toHaveBeenCalledTimes(2);

    selectSpy.mockRestore();
  });

  it('invalidate() forces an immediate reload on the next match', async () => {
    const cache = new BannedNameRuleCache(db, 30_000);
    expect(await cache.match('NewRuleUser')).toBeNull();

    await db.insert(bannedNameRules).values({
      id: RULE_B,
      pattern: 'newruleuser',
      matchType: 'exact',
      action: 'alert',
      isActive: true,
    });
    cache.invalidate();

    expect(await cache.match('NewRuleUser')).toMatchObject({ ruleId: RULE_B });
  });
});
