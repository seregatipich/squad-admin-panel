import { and, eq } from 'drizzle-orm';
import type { DatabaseClient } from './client.js';
import { alertEvents, alertRules, seedSubscriptions } from './schema/index.js';

export const SEED_ALERT_EVENT_KINDS = ['seed.call_sent', 'server.seeding_started'] as const;
export type SeedAlertEventKind = (typeof SEED_ALERT_EVENT_KINDS)[number];

interface SeedAlertRuleConfig {
  eventKind?: string;
}

interface RedisPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface SeedNotificationInput {
  serverId: string;
  eventKind: SeedAlertEventKind;
  payload: Record<string, unknown>;
}

/**
 * Materializes one AUTO-3 alert event per matching player/channel
 * subscription and publishes the same recipient-scoped frame to the live bus.
 * The alert rule is the delivery policy (severity/channels); the subscription
 * is the recipient opt-in. Missing rules or subscriptions are a safe no-op.
 */
export async function notifySeedSubscribers(
  db: DatabaseClient,
  redis: RedisPublisher,
  input: SeedNotificationInput,
): Promise<number> {
  const [subscriptions, rules] = await Promise.all([
    db
      .select({ playerId: seedSubscriptions.playerId, channel: seedSubscriptions.channel })
      .from(seedSubscriptions)
      .where(eq(seedSubscriptions.serverId, input.serverId)),
    db
      .select({ id: alertRules.id, config: alertRules.config, channels: alertRules.channels })
      .from(alertRules)
      .where(and(eq(alertRules.type, 'custom'), eq(alertRules.enabled, true))),
  ]);

  const matchingRules = rules.filter(
    (rule) => (rule.config as SeedAlertRuleConfig).eventKind === input.eventKind,
  );
  let notified = 0;
  for (const subscription of subscriptions) {
    for (const rule of matchingRules) {
      const channels = Array.isArray(rule.channels) ? rule.channels : [];
      if (!channels.includes(subscription.channel)) continue;

      const payload = {
        ...input.payload,
        event_kind: input.eventKind,
        player_id: subscription.playerId,
        channel: subscription.channel,
      };
      await db.insert(alertEvents).values({
        ruleId: rule.id,
        severity: 'info',
        payload,
      });
      await redis.publish(
        'live-bus',
        JSON.stringify({ type: 'alert.triggered', ts: new Date().toISOString(), data: payload }),
      );
      notified++;
    }
  }
  return notified;
}
