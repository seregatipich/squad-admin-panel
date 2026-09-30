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

  // At most one alert event per subscription: when several enabled custom
  // rules match the same event kind and channel, the first one found wins
  // rather than duplicating the event per matching rule.
  const events: Array<{ ruleId: string; severity: 'info'; payload: Record<string, unknown> }> = [];
  for (const subscription of subscriptions) {
    const rule = matchingRules.find((candidate) => {
      const channels = Array.isArray(candidate.channels) ? candidate.channels : [];
      return channels.includes(subscription.channel);
    });
    if (!rule) continue;

    events.push({
      ruleId: rule.id,
      severity: 'info',
      payload: {
        ...input.payload,
        event_kind: input.eventKind,
        player_id: subscription.playerId,
        channel: subscription.channel,
      },
    });
  }

  if (events.length === 0) return 0;

  // A single batched insert instead of one INSERT per subscription avoids
  // partial materialization if the statement fails partway through.
  await db.insert(alertEvents).values(events);
  await Promise.all(
    events.map((event) =>
      redis.publish(
        'live-bus',
        JSON.stringify({
          type: 'alert.triggered',
          ts: new Date().toISOString(),
          data: event.payload,
        }),
      ),
    ),
  );
  return events.length;
}
