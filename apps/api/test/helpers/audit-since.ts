import type { DatabaseClient } from '@squad/db';
import { auditLog } from '@squad/db/schema';
import { and, desc, eq, gt } from 'drizzle-orm';
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
