import { type DatabaseClient, events } from '@squad/db';
import type { EventEnvelope } from '@squad/shared-types';

export interface PersistEventResult {
  eventId: string;
  /** `false` when the envelope was already stored (a replayed log line). */
  inserted: boolean;
}

/**
 * Stores one envelope in `events`. Idempotent through the table's primary key
 * `(event_id, occurred_at)`: log-ingest derives both from the log line, so a
 * replay conflicts and is skipped. No `processed_events` row is written — it
 * duplicated that guarantee and, never pruned, grew by one row per log line
 * (#62).
 */
export async function persistEventEnvelope(
  db: DatabaseClient,
  envelope: EventEnvelope,
): Promise<PersistEventResult> {
  const inserted = await db
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
}
