import type { DatabaseClient } from '@squad/db';
import { auditLog } from '@squad/db/schema';
import { and, desc, eq, gt, type SQL } from 'drizzle-orm';
import { expect } from 'vitest';

// Audit assertions for suites that share one integration harness across their
// tests. `assertAuditRow` without a target id accepts any recent row, so for an
// action that audits no target id an earlier test's row would satisfy it; mark
// the log before each case and accept only rows written after the mark.

/** Returns the newest audit_log id, or 0n for an empty log. */
export async function auditLogMark(db: DatabaseClient): Promise<bigint> {
  const [latest] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(1);
  return latest?.id ?? 0n;
}

/**
 * Waits up to 1.2 s (the audit onResponse hook finishes shortly after
 * `inject` resolves) for an audit row newer than `mark` with the given action
 * and target type, failing the test if none appears.
 *
 * @param db - the harness database the audit plugin writes to
 * @param mark - an id from {@link auditLogMark} taken before the case acted
 * @param expected.action - the row's `action_type`
 * @param expected.resource - the row's `target_type`
 */
export async function expectAuditRowSince(
  db: DatabaseClient,
  mark: bigint,
  expected: { action: string; resource: string },
): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await db
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(
              and(
                gt(auditLog.id, mark),
                eq(auditLog.actionType, expected.action),
                eq(auditLog.targetType, expected.resource),
              ),
            )
            .limit(1)
        ).length,
      { timeout: 1_200, interval: 50 },
    )
    .toBe(1);
}

/**
 * Waits up to 5 s for at least `count` audit rows matching `where` and returns
 * every match, oldest first. The audit hook writes after the response is sent,
 * so a case that reads `audit_log` right after `inject` resolves must poll.
 *
 * @param db - the harness database the audit plugin writes to
 * @param where - filter selecting the case's own rows (action, target, actor)
 * @param count - how many rows must exist before the rows are returned
 */
export async function waitForAuditRows(
  db: DatabaseClient,
  where: SQL | undefined,
  count = 1,
): Promise<(typeof auditLog.$inferSelect)[]> {
  let rows: (typeof auditLog.$inferSelect)[] = [];
  await expect
    .poll(
      async () => {
        rows = await db.select().from(auditLog).where(where).orderBy(auditLog.id);
        return rows.length;
      },
      { timeout: 5_000, interval: 25 },
    )
    .toBeGreaterThanOrEqual(count);
  return rows;
}
