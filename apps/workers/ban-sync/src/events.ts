import type { DatabaseClient } from '@squad/db';
import { events, processedEvents } from '@squad/db/schema';
import { DEDUP_KEY, DEDUP_TTL_SECONDS, type EventEnvelope, STREAM_NAME } from '@squad/shared-types';
import type Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

export const EVENT_PERSIST_GROUP = 'worker-ban-sync:v1';

export type BansyncEventType = 'bansync.completed' | 'bansync.failed';

export interface BansyncCompletedPayload {
  source_id: string;
  added: number;
  updated: number;
  revoked: number;
  skipped: number;
  duration_ms: number;
  bytes: number;
}

export interface BansyncFailedPayload {
  source_id: string;
  error: string;
  consecutive_failures: number;
  duration_ms: number | null;
}

/** Builds a validated `bansync.*` envelope with a system actor, ready to persist and publish. */
export function buildBansyncEnvelope(
  type: BansyncEventType,
  payload: BansyncCompletedPayload | BansyncFailedPayload,
): EventEnvelope {
  return {
    event_id: uuidv7(),
    version: 1,
    type,
    server_id: null,
    ts: new Date().toISOString(),
    actor: { kind: 'system', id: 'ban-sync' },
    correlation_id: null,
    payload,
  };
}

/**
 * Persists an envelope to `events` (claimed via `processed_events` so a
 * retried call is a no-op), then publishes it to `events:global` (with
 * producer-side dedup, mirroring `log-ingest/src/publish.ts`) and to the
 * `live-bus` pub/sub channel the admin UI listens on.
 */
export async function persistAndPublish(
  db: DatabaseClient,
  redis: Pick<Redis, 'set' | 'xadd' | 'publish'>,
  envelope: EventEnvelope,
): Promise<void> {
  await db.transaction(async (tx) => {
    const claimed = await tx
      .insert(processedEvents)
      .values({ eventId: envelope.event_id, groupName: EVENT_PERSIST_GROUP })
      .onConflictDoNothing({ target: processedEvents.eventId })
      .returning({ eventId: processedEvents.eventId });

    if (claimed.length === 0) return;

    await tx
      .insert(events)
      .values({
        eventId: envelope.event_id,
        serverId: envelope.server_id,
        occurredAt: new Date(envelope.ts),
        kind: envelope.type,
        version: envelope.version,
        actorKind: envelope.actor?.kind ?? null,
        actorId: envelope.actor?.id ?? null,
        correlationId: envelope.correlation_id,
        payload: envelope.payload,
      })
      .onConflictDoNothing({ target: [events.eventId, events.occurredAt] });
  });

  const dedupKey = DEDUP_KEY(EVENT_PERSIST_GROUP, envelope.event_id);
  const claimedForPublish = await redis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
  if (claimedForPublish) {
    await redis.xadd(
      STREAM_NAME.eventsGlobal(),
      'MAXLEN',
      '~',
      '10000',
      '*',
      'envelope',
      JSON.stringify(envelope),
    );
  }

  await redis.publish(
    'live-bus',
    JSON.stringify({ type: envelope.type, ts: envelope.ts, data: envelope.payload }),
  );
}
