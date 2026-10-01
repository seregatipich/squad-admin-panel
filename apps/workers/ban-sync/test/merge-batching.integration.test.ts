import { createDatabaseClient, externalBanSources, externalBans } from '@squad/db';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import type { ParsedBan } from '../src/adapters/index.js';
import { applyMergePlan, planMerge } from '../src/merge.js';

const DATABASE_URL = process.env.DATABASE_URL;
const db = DATABASE_URL ? createDatabaseClient(DATABASE_URL) : null;
let sourceId = '';

// Ten bound parameters per inserted row put postgres.js's 65534-parameter cap at
// ~6553 rows; 7000 crosses it, which a single-statement insert cannot survive.
const LARGE_IMPORT_ROWS = 7000;

function parsedBan(index: number): ParsedBan {
  return {
    steamId64: String(76561190000000000n + BigInt(index)),
    eosId: null,
    nickname: `bulk-${index}`,
    reason: 'bulk import',
    adminName: null,
    issuedAt: null,
    expiresAt: null,
    raw: { line: index },
  };
}

beforeAll(async () => {
  if (!db) return;
  const [source] = await db
    .insert(externalBanSources)
    .values({
      name: 'bulk merge test',
      url: 'https://example.invalid/bans.cfg',
      format: 'squad_bans_cfg',
    })
    .returning({ id: externalBanSources.id });
  sourceId = source?.id ?? '';
});

afterAll(async () => {
  if (!db) return;
  await db.delete(externalBanSources).where(eq(externalBanSources.id, sourceId));
  await db.$client.end();
});

describeIfDb('applyMergePlan against a large public ban list', () => {
  it('imports and later revokes more rows than one statement can bind', async () => {
    if (!db) throw new Error('database not configured');
    const incoming = Array.from({ length: LARGE_IMPORT_ROWS }, (_, index) => parsedBan(index));

    const inserted = await applyMergePlan(db, sourceId, planMerge([], incoming));
    expect(inserted.added).toBe(LARGE_IMPORT_ROWS);
    const [stored] = await db
      .select({ n: count() })
      .from(externalBans)
      .where(eq(externalBans.sourceId, sourceId));
    expect(stored?.n).toBe(LARGE_IMPORT_ROWS);

    const existing = await db
      .select()
      .from(externalBans)
      .where(eq(externalBans.sourceId, sourceId));
    const revokePlan = planMerge(existing, []);
    expect(revokePlan.toRevokeIds.length).toBe(LARGE_IMPORT_ROWS);
    const revoked = await applyMergePlan(db, sourceId, revokePlan);
    expect(revoked.revoked).toBe(LARGE_IMPORT_ROWS);
    const [revokedRows] = await db
      .select({ n: count() })
      .from(externalBans)
      .where(and(eq(externalBans.sourceId, sourceId), isNotNull(externalBans.revokedAt)));
    expect(revokedRows?.n).toBe(LARGE_IMPORT_ROWS);
  });
});
