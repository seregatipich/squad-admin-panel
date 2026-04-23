/**
 * Dynamic proof for TZ §17.5 DLQ + XAUTOCLAIM behaviour.
 * Exercises the redis primitives the workers rely on.
 *
 * Runs only when REDIS_URL is set (skipped on the unit CI matrix).
 */
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const redisUrl = process.env.REDIS_URL ?? process.env.REDIS_TEST_URL;

const describeIf = redisUrl ? describe : describe.skip;

describeIf('events stream DLQ + XAUTOCLAIM', () => {
  const r = new Redis(redisUrl ?? 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 2 });
  const stream = 'events:test:dlq-autoclaim';
  const dlq = 'events:dlq';
  const group = 'test-consumer:v1';
  const consumerA = 'a';
  const consumerB = 'b';

  beforeAll(async () => {
    await r.del(stream);
    await r.del(dlq);
  });

  afterAll(async () => {
    await r.del(stream);
    await r.del(dlq);
    await r.quit();
  });

  it('after 5 failed deliveries, consumer publishes to events:dlq and acks the original', async () => {
    await r.xadd(stream, '*', 'envelope', JSON.stringify({ event_id: 'test-1', type: 'ping' }));
    try {
      await r.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch {
      // group exists
    }
    let deliveryCount = 0;
    let dlqued = false;

    for (let attempt = 0; attempt < 7; attempt++) {
      const res = (await r.xreadgroup(
        'GROUP',
        group,
        consumerA,
        'COUNT',
        '1',
        'BLOCK',
        '100',
        'STREAMS',
        stream,
        '>',
      )) as Array<[string, Array<[string, string[]]>]> | null;
      let messageId: string | null = null;
      if (res) {
        for (const [, entries] of res) {
          for (const [id] of entries) messageId = id;
        }
      }
      if (!messageId) {
        // No new "unclaimed" message; look up pending
        const pending = (await r.xpending(stream, group)) as unknown as [
          number,
          string,
          string,
          string[][],
        ];
        const count = Array.isArray(pending) ? Number(pending[0]) : 0;
        if (count === 0) break;
        const detail = (await r.xpending(stream, group, '-', '+', '1', consumerA)) as Array<
          [string, string, number, number]
        >;
        if (!detail || detail.length === 0) break;
        const row = detail[0];
        if (!row) break;
        messageId = row[0];
        deliveryCount = row[3];
        if (deliveryCount >= 5) {
          await r.xadd(dlq, '*', 'from', stream, 'id', messageId, 'reason', 'max_retries_reached');
          await r.xack(stream, group, messageId);
          dlqued = true;
          break;
        }
        // Force re-delivery by claiming with idle=0 back to self
        await r.xclaim(stream, group, consumerA, '0', messageId);
      } else {
        // Simulate handler throw: don't ack; loop will see it as pending
        deliveryCount++;
      }
    }

    expect(dlqued).toBe(true);
    const dlqLen = await r.xlen(dlq);
    expect(dlqLen).toBeGreaterThan(0);
  });

  it('XAUTOCLAIM reassigns messages idle > threshold from A to B', async () => {
    const stream2 = `${stream}:reclaim`;
    await r.del(stream2);
    try {
      await r.xgroup('CREATE', stream2, group, '0', 'MKSTREAM');
    } catch {
      // already exists
    }
    await r.xadd(stream2, '*', 'envelope', JSON.stringify({ event_id: 'test-rc', type: 'ping' }));
    const delivered = (await r.xreadgroup(
      'GROUP',
      group,
      consumerA,
      'COUNT',
      '1',
      'STREAMS',
      stream2,
      '>',
    )) as Array<[string, Array<[string, string[]]>]> | null;
    expect(delivered).not.toBeNull();
    // Wait a short time, then XAUTOCLAIM with min-idle-time=5ms so B takes it
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reclaimed = (await r.xautoclaim(stream2, group, consumerB, '10', '0', 'COUNT', '10')) as [
      string,
      Array<[string, string[]]>,
      string[],
    ];
    const claimedEntries = reclaimed[1];
    expect(claimedEntries.length).toBeGreaterThan(0);
    // Ack to clean up
    if (claimedEntries[0]) await r.xack(stream2, group, claimedEntries[0][0]);
    await r.del(stream2);
  });
});
