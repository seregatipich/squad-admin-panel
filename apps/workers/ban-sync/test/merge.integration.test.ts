// Regression (#34): `raw` round-trips through a jsonb column, and Postgres
// re-orders jsonb object keys (by length, then bytes). Comparing it with
// `JSON.stringify` therefore saw every json_generic / battlemetrics_json ban
// as changed on every poll and re-issued an UPDATE for each one.
import { createDatabaseClient, type DatabaseClient } from '@squad/db';
import { externalBanSources, externalBans } from '@squad/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { createSyncSourceDeps, type SyncSourceDeps, syncSource } from '../src/sync-source.js';

const DATABASE_URL = process.env.DATABASE_URL;

// Keys deliberately NOT in jsonb order (length, then bytes), nested too.
const BAN_LIST = JSON.stringify([
  {
    steam_id64: '76561197000034001',
    reason: 'cheating',
    nickname: 'Ghost',
    issued_at: '2026-09-01T10:00:00.000Z',
    meta: { source_ref: 'abc', id: 7, zeta: [{ b: 1, a: 2 }] },
    id: 'ban-1',
  },
  {
    eos_id: '0002a0b0c0d0e0f0a1b2c3d4e5f60034',
    reason: 'teamkilling',
    admin_name: 'AdminY',
    expires_at: '2027-01-01T00:00:00.000Z',
    id: 'ban-2',
  },
]);

describeIfDb('syncSource against the real external_bans table', () => {
  let db: DatabaseClient;
  let sourceId: string;

  beforeAll(async () => {
    db = createDatabaseClient(DATABASE_URL as string);
    const [row] = await db
      .insert(externalBanSources)
      .values({
        name: `merge-roundtrip-${Date.now()}`,
        url: 'https://bans.example.org/list.json',
        format: 'json_generic',
      })
      .returning({ id: externalBanSources.id });
    sourceId = row?.id as string;
  });

  afterAll(async () => {
    if (sourceId) {
      await db.delete(externalBans).where(eq(externalBans.sourceId, sourceId));
      await db.delete(externalBanSources).where(eq(externalBanSources.id, sourceId));
    }
  });

  function deps(): SyncSourceDeps {
    return {
      ...createSyncSourceDeps(
        db,
        {} as never,
        { emit: vi.fn().mockResolvedValue(undefined) },
        Buffer.alloc(32).toString('base64'),
      ),
      fetchBanList: vi
        .fn()
        .mockResolvedValue({ text: BAN_LIST, bytes: BAN_LIST.length, durationMs: 1 }),
      persistAndPublish: vi.fn().mockResolvedValue(undefined),
      onSyncComplete: undefined,
      raiseFailureAlert: vi.fn().mockResolvedValue(0),
    };
  }

  const source = () => ({
    id: sourceId,
    name: 'merge-roundtrip',
    url: 'https://bans.example.org/list.json',
    format: 'json_generic' as const,
    authHeaderEncrypted: null,
    parserConfig: {},
    consecutiveFailures: 0,
  });

  it('a second sync of an unchanged json_generic list updates nothing', async () => {
    const first = await syncSource(deps(), source());
    expect(first).toMatchObject({ ok: true, added: 2, updated: 0, revoked: 0 });

    const second = await syncSource(deps(), source());
    expect(second).toMatchObject({ ok: true, added: 0, updated: 0, revoked: 0 });

    const [src] = await db
      .select({ importedCount: externalBanSources.importedCount })
      .from(externalBanSources)
      .where(eq(externalBanSources.id, sourceId));
    expect(src?.importedCount).toBe(0);
  });
});
