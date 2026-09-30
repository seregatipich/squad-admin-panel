import { DEDUP_KEY, DEDUP_TTL_SECONDS, type EventEnvelope, STREAM_NAME } from '@squad/shared-types';
import type Redis from 'ioredis';
import { streamFor } from './parser/ingest.js';

/**
 * Publish a single envelope to the per-server stream with client-side
 * dedup. The real idempotency happens at the consumer: they check
 * dedup:${group}:${event_id} before processing. The producer-side key only
 * suppresses re-publishing a line that was already appended to the stream; it
 * is released when XADD fails so a re-read of the same line can publish again.
 */
export async function publish(redis: Redis, envelope: EventEnvelope): Promise<void> {
  const key = DEDUP_KEY('log-ingest:v1', envelope.event_id);
  const claim = await redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
  if (!claim) return;

  try {
    await redis.xadd(
      envelope.server_id ? streamFor(envelope.server_id) : STREAM_NAME.eventsGlobal(),
      'MAXLEN',
      '~',
      '10000',
      '*',
      'envelope',
      JSON.stringify(envelope),
    );
  } catch (err) {
    await redis.del(key);
    throw err;
  }
}
