import { STREAM_NAME } from '@squad/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { buildBansyncEnvelope, persistAndPublish } from '../src/events.js';

function fakeDb() {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as never, insert, values };
}

describe('persistAndPublish', () => {
  const envelope = buildBansyncEnvelope('bansync.completed', {
    source_id: 's1',
    added: 1,
    updated: 0,
    revoked: 0,
    skipped: 0,
    duration_ms: 5,
    bytes: 10,
  });

  it('writes the event and appends it to events:global without dedup bookkeeping', async () => {
    const { db, insert, values } = fakeDb();
    const redis = { xadd: vi.fn().mockResolvedValue('1-0') };

    await persistAndPublish(db, redis, envelope);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: envelope.event_id, kind: 'bansync.completed' }),
    );
    expect(redis.xadd).toHaveBeenCalledWith(
      STREAM_NAME.eventsGlobal(),
      'MAXLEN',
      '~',
      '10000',
      '*',
      'envelope',
      JSON.stringify(envelope),
    );
  });

  it('never publishes to the live-bus channel', async () => {
    const { db } = fakeDb();
    const redis = { xadd: vi.fn().mockResolvedValue('1-0'), publish: vi.fn(), set: vi.fn() };

    await persistAndPublish(db, redis, envelope);

    expect(redis.publish).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });
});
