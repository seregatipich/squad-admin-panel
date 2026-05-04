import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';

describe('shared-types index re-exports', () => {
  it('re-exports api schemas', () => {
    expect(typeof root.serverCreateInput.safeParse).toBe('function');
    expect(typeof root.uuidString.safeParse).toBe('function');
    expect(typeof root.paginated).toBe('function');
  });

  it('re-exports event schemas and helpers', () => {
    expect(Array.isArray(root.EVENT_TYPES)).toBe(true);
    expect(typeof root.eventEnvelope.safeParse).toBe('function');
    expect(typeof root.validatePayload).toBe('function');
    expect(root.STREAM_NAME.eventsServer('abc')).toBe('events:server:abc');
    expect(root.STREAM_NAME.eventsGlobal()).toBe('events:global');
    expect(root.STREAM_NAME.eventsDlq()).toBe('events:dlq');
    expect(root.DEDUP_KEY('players-projector:v1', 'evt-1')).toBe(
      'dedup:players-projector:v1:evt-1',
    );
    expect(root.DEDUP_TTL_SECONDS).toBe(86_400);
    expect(root.CONSUMER_GROUP.playersProjector).toBe('players-projector:v1');
    expect(root.CONSUMER_GROUP.auditArchiver).toBe('audit-archiver:v1');
    expect(root.CONSUMER_GROUP.stats).toBe('stats:v1');
    expect(root.XAUTOCLAIM_IDLE_MS).toBe(120_000);
    expect(root.XAUTOCLAIM_TICK_MS).toBe(30_000);
    expect(root.DLQ_DELIVER_THRESHOLD).toBe(5);
  });
});
