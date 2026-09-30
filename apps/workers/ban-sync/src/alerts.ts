import type { DatabaseClient } from '@squad/db';
import { alertEvents, alertRules } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

interface CustomAlertRuleConfig {
  eventKind?: string;
  severity?: 'info' | 'warning' | 'critical';
}

interface SourceRef {
  id: string;
  name: string;
}

/**
 * AUTO-3 integration for ban-sync failures: fires only when an enabled
 * `type = 'custom'` alert rule configured with `config.eventKind =
 * 'bansync.failed'` exists — `alert_events.rule_id` is a NOT NULL FK, so a
 * rule is structurally required. A deployment with no such rule configured
 * gets no alert (rule-driven, not always-on). The alert is recorded in
 * `alert_events` only: it names the source and its fetch error, so it is not
 * broadcast on the `live-bus` WebSocket channel that every viewer receives.
 */
export async function raiseBanSyncFailureAlert(
  db: DatabaseClient,
  source: SourceRef,
  errorText: string,
  consecutiveFailures: number,
): Promise<number> {
  const rules = await db
    .select({ id: alertRules.id, config: alertRules.config })
    .from(alertRules)
    .where(and(eq(alertRules.type, 'custom'), eq(alertRules.enabled, true)));

  let raised = 0;
  for (const rule of rules) {
    const config = rule.config as CustomAlertRuleConfig;
    if (config.eventKind !== 'bansync.failed') continue;

    const severity = config.severity ?? 'warning';
    const payload = {
      source_id: source.id,
      source_name: source.name,
      error: errorText,
      consecutive_failures: consecutiveFailures,
    };
    await db.insert(alertEvents).values({
      id: uuidv7(),
      ruleId: rule.id,
      severity,
      payload,
    });
    raised++;
  }
  return raised;
}
