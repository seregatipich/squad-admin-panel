/** Audit-log assertions of the integration harness. */

import { auditLog } from '@squad/db/schema';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { IntegrationHarness } from './types.js';

/**
 * Asserts that an audit_log row exists matching the given action+target with
 * created_at within the last `withinMs` milliseconds. Polls up to ~1s because
 * Fastify's `onResponse` audit hook runs after `inject()` resolves.
 */
export async function assertAuditRow(
  h: IntegrationHarness,
  expected: {
    action: string;
    resource?: string;
    targetId?: string | null;
    statusCode?: number;
    withinMs?: number;
  },
): Promise<typeof auditLog.$inferSelect> {
  const withinMs = expected.withinMs ?? 5_000;
  const cutoff = new Date(Date.now() - withinMs);
  const deadline = Date.now() + 1_200;
  const filters = () =>
    and(
      eq(auditLog.actionType, expected.action),
      gte(auditLog.createdAt, cutoff),
      ...(expected.resource ? [eq(auditLog.targetType, expected.resource)] : []),
      ...(expected.targetId != null ? [eq(auditLog.targetId, expected.targetId)] : []),
      ...(expected.statusCode != null ? [eq(auditLog.statusCode, expected.statusCode)] : []),
    );
  // Polling loop — onResponse hook completes shortly after inject resolves.
  while (Date.now() < deadline) {
    const rows = await h.db
      .select()
      .from(auditLog)
      .where(filters())
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    const first = rows[0];
    if (first) return first;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `expected audit row with action=${expected.action} resource=${expected.resource ?? 'any'} within ${withinMs}ms; none found after polling`,
  );
}
