import { createDatabaseClient, events, processedEvents, servers } from '@squad/db';
import type { EventEnvelope } from '@squad/shared-types';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { persistEventEnvelope } from '../src/event-store.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must point at the event-store test database');

const db = createDatabaseClient(DATABASE_URL);

const SERVER_ID = uuidv7();
const EVENT_ID = uuidv7();

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: EVENT_ID,
    version: 1,
    type: 'player.connected',
    server_id: SERVER_ID,
    ts: '2026-07-07T19:00:00.000Z',
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload: {
      eos_id: '0002aaaa0002aaaa0002aaaa0002aaaa',
      steam_id64: '76561198000000001',
      name: 'PersistedPlayer',
      ip: null,
    },
    ...overrides,
  };
}

async function eventRows() {
  return db.select().from(events).where(eq(events.eventId, EVENT_ID));
}

async function processedRows() {
  return db.select().from(processedEvents).where(eq(processedEvents.eventId, EVENT_ID));
}

beforeAll(async () => {
  await db.insert(servers).values({
    id: SERVER_ID,
    displayName: 'Event Store Test Server',
    slug: `event-store-${SERVER_ID.slice(0, 8)}`,
  });
});

beforeEach(async () => {
  await db.delete(events).where(eq(events.eventId, EVENT_ID));
  await db.delete(processedEvents).where(eq(processedEvents.eventId, EVENT_ID));
});

afterAll(async () => {
  await db.delete(events).where(eq(events.eventId, EVENT_ID));
  await db.delete(processedEvents).where(eq(processedEvents.eventId, EVENT_ID));
  await db.delete(servers).where(eq(servers.id, SERVER_ID));
  await db.$client.end();
});

describe('persistEventEnvelope', () => {
  it('writes a generic event envelope and processed marker', async () => {
    const result = await persistEventEnvelope(db, makeEnvelope());

    expect(result).toEqual({ eventId: EVENT_ID, inserted: true });

    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId: EVENT_ID,
      serverId: SERVER_ID,
      kind: 'player.connected',
      version: 1,
      actorKind: 'system',
      actorId: null,
      correlationId: null,
    });
    expect(rows[0]?.occurredAt.toISOString()).toBe('2026-07-07T19:00:00.000Z');
    expect(rows[0]?.payload).toMatchObject({ name: 'PersistedPlayer' });

    const processed = await processedRows();
    expect(processed).toHaveLength(1);
    expect(processed[0]?.groupName).toBe('worker-log-ingest:persist-events:v1');
  });

  it('does not duplicate the event on replay of the same envelope', async () => {
    await persistEventEnvelope(db, makeEnvelope());
    const replay = await persistEventEnvelope(db, makeEnvelope());

    expect(replay).toEqual({ eventId: EVENT_ID, inserted: false });
    expect(await eventRows()).toHaveLength(1);
    expect(await processedRows()).toHaveLength(1);
  });
});
