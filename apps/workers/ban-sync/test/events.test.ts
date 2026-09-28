import { createDatabaseClient, events, processedEvents } from '@squad/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildBansyncEnvelope, persistAndPublish } from '../src/events.js';

// regression (#62): the envelope insert is idempotent through the events primary
// key, so persisting no longer writes an unpruned processed_events row per event.
const DATABASE_URL =
  process.env.DATABASE_URL ??
  `postgres://admin:${process.env.POSTGRES_PASSWORD ?? 'admin'}@127.0.0.1:5432/admin`;

const db = createDatabaseClient(DATABASE_URL);
const envelope = buildBansyncEnvelope('bansync.completed', {
  source_id: 'ban-sync-events-test',
  added: 1,
  updated: 0,
  revoked: 0,
  skipped: 0,
  duration_ms: 5,
  bytes: 10,
});

function makeRedis() {
  return {
    set: vi.fn(async () => 'OK' as const),
    xadd: vi.fn(async () => '1-0'),
    publish: vi.fn(async () => 1),
  };
}

afterEach(async () => {
  await db.delete(events).where(eq(events.eventId, envelope.event_id));
  await db.delete(processedEvents).where(eq(processedEvents.eventId, envelope.event_id));
});

afterAll(async () => {
  await db.$client.end();
});

describe('persistAndPublish', () => {
  it('stores the envelope once across retries without a processed_events row', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: fake exposes only set/xadd/publish
    const redis = makeRedis() as any;

    await persistAndPublish(db, redis, envelope);
    await persistAndPublish(db, redis, envelope);

    const stored = await db.select().from(events).where(eq(events.eventId, envelope.event_id));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.kind).toBe('bansync.completed');
    const processed = await db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.eventId, envelope.event_id));
    expect(processed).toHaveLength(0);
  });
});
