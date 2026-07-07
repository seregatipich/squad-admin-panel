import { type DatabaseClient, events, processedEvents } from '@squad/db';
import type { EventEnvelope } from '@squad/shared-types';

export const EVENT_PERSIST_GROUP = 'worker-log-ingest:persist-events:v1';

export interface PersistEventResult {
  eventId: string;
  inserted: boolean;
}

export async function persistEventEnvelope(
  db: DatabaseClient,
  envelope: EventEnvelope,
): Promise<PersistEventResult> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(processedEvents)
      .values({
        eventId: envelope.event_id,
        groupName: EVENT_PERSIST_GROUP,
      })
      .onConflictDoNothing({ target: processedEvents.eventId })
      .returning({ eventId: processedEvents.eventId });

    if (claimed.length === 0) {
      return { eventId: envelope.event_id, inserted: false };
    }

    const inserted = await tx
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
      .onConflictDoNothing({ target: [events.eventId, events.occurredAt] })
      .returning({ eventId: events.eventId });

    return { eventId: envelope.event_id, inserted: inserted.length > 0 };
  });
}
