import type { DatabaseClient } from '@squad/db';
import { alertEvents, alertRules } from '@squad/db/schema';
import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

interface AltBanAlertConfig {
  eventKind?: string;
  severity?: 'info' | 'warning' | 'critical';
}

export interface AltBanAlertPayload {
  target_player_id: string;
  confirmed_alt_ids: string[];
  candidate_ids: string[];
  trigger: 'admin_ban';
}

/** Raises the configured AUTO-3 custom alert for a ban involving alt signals. */
export async function raiseAltBanAlert(
  db: DatabaseClient,
  redis: Pick<Redis, 'publish'>,
  payload: AltBanAlertPayload,
): Promise<number> {
  const rules = await db
    .select({ id: alertRules.id, config: alertRules.config })
    .from(alertRules)
    .where(and(eq(alertRules.type, 'custom'), eq(alertRules.enabled, true)));

  let raised = 0;
  for (const rule of rules) {
    const config = rule.config as AltBanAlertConfig;
    if (config.eventKind !== 'alt.ban_evasion_suspected') continue;
    const severity = config.severity ?? 'warning';
    await db.insert(alertEvents).values({
      id: uuidv7(),
      ruleId: rule.id,
      severity,
      payload,
    });
    await redis.publish(
      'live-bus',
      JSON.stringify({ type: 'alert.triggered', ts: new Date().toISOString(), data: payload }),
    );
    raised++;
  }
  return raised;
}
