import { DEDUP_KEY, DEDUP_TTL_SECONDS, type EventEnvelope } from '@squad/shared-types';
import type Redis from 'ioredis';
import { streamFor } from './parser/ingest.js';

/**
 * Publish a single envelope to the per-server stream with client-side
 * best-effort dedup. The real idempotency happens at the consumer:
 * they check dedup:${group}:${event_id} before processing. This
 * producer-side key is a no-op on the first call.
 */
export async function publish(redis: Redis, envelope: EventEnvelope): Promise<void> {
  const key = DEDUP_KEY('log-ingest:v1', envelope.event_id);
  const claim = await redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
  if (!claim) return;

  await redis.xadd(
    envelope.server_id ? streamFor(envelope.server_id) : 'events:global',
    'MAXLEN',
    '~',
    '10000',
    '*',
    'envelope',
    JSON.stringify(envelope),
  );
}
