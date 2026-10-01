import { createDatabaseClient } from '@squad/db';
import { auditLog } from '@squad/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIfDb } from '../../../../packages/db/test/helpers/describe-if.js';
import { createIsolatedPackageTestDatabase } from '../../../../packages/db/test/helpers/isolated-database.js';
import { appendWorkerAudit } from '../src/audit.js';

const DATABASE_URL = process.env.DATABASE_URL;

describeIfDb('appendWorkerAudit', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPackageTestDatabase>>;
  let db: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    isolated = await createIsolatedPackageTestDatabase(DATABASE_URL, 'config_sync_audit');
    db = createDatabaseClient(isolated.url);
  }, 120_000);

  afterAll(async () => {
    await isolated?.drop();
  });

  it('writes a system-actor row whose hash chain is maintained by the trigger', async () => {
    const targetId = `srv-${uuidv7()}`;
    const entry = {
      actorPlayerId: null,
      actionType: 'admins_cfg.synced',
      targetType: 'server',
      targetId,
      before: null,
      after: { segment_hash: 'def' },
      context: { groups_count: 2 },
    };

    await appendWorkerAudit(db, entry);
    await appendWorkerAudit(db, { ...entry, before: { segment_hash: 'def' }, after: null });

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, targetId), eq(auditLog.actionType, entry.actionType)))
      .orderBy(asc(auditLog.id));
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first).toMatchObject({
      actorKind: 'system',
      actorPlayerId: null,
      actorSystemLabel: 'worker-config-sync',
      beforeSnapshot: null,
      afterSnapshot: { segment_hash: 'def' },
      context: { groups_count: 2 },
    });
    expect(first?.rowHash.length).toBe(32);
    expect(second?.prevHash).toEqual(first?.rowHash);
  });
});
