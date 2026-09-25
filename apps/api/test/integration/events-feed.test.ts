import { randomUUID } from 'node:crypto';
import { events, servers } from '@squad/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import diagPlugin from '../../src/lib/diag.js';
import eventsFeedPlugin from '../../src/plugins/events-feed.js';
import liveBusPlugin, { type LiveEvent } from '../../src/plugins/live-bus.js';
import liveRoutes from '../../src/routes/live.js';
import { hostDbUrl } from './isolated-db.js';

/**
 * End to end through the real wiring: a row inserted into `events` fires the
 * migration-0116 trigger, Postgres NOTIFYs `events_appended`, the events-feed
 * plugin LISTENs, and the frame reaches a browser socket on /api/v1/ws/live.
 */

let app: FastifyInstance;
let port: number;
let sql: ReturnType<typeof postgres>;

beforeEach(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture — redis stub without pub/sub
  (app as any).decorate('redis', { xadd: async () => '0-0' });
  await app.register(await import('@fastify/websocket').then((m) => m.default));
  await app.register(diagPlugin);
  await app.register(liveBusPlugin);
  await app.register(eventsFeedPlugin, { databaseUrl: hostDbUrl(), debounceMs: 50 });
  await app.register(liveRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
  sql = postgres(hostDbUrl(), { max: 2, onnotice: () => undefined });
});

afterEach(async () => {
  await sql.end();
  await app.close();
});

/** A real `servers` row: `events.server_id` is a foreign key. */
async function makeServer(): Promise<string> {
  const id = randomUUID();
  const slug = `feed-${id.slice(0, 8)}`;
  await drizzle(sql).insert(servers).values({ id, displayName: slug, slug, status: 'running' });
  return id;
}

function insertEvent(serverId: string | null, kind: string) {
  return drizzle(sql).insert(events).values({
    eventId: randomUUID(),
    serverId,
    occurredAt: new Date(),
    kind,
    version: 1,
    actorKind: 'system',
    payload: {},
  });
}

async function openSocket(): Promise<{ ws: WebSocket; frames: LiveEvent[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`);
  const frames: LiveEvent[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as LiveEvent));
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  return { ws, frames };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const appended = (frames: LiveEvent[]) =>
  frames.filter(
    (f): f is Extract<LiveEvent, { type: 'server.events.appended' }> =>
      f.type === 'server.events.appended',
  );

describe('events feed (NOTIFY → live-bus → WebSocket)', () => {
  it('pushes server.events.appended the moment an event row is stored', async () => {
    const { ws, frames } = await openSocket();
    const serverId = await makeServer();
    const insertedAt = Date.now();
    await insertEvent(serverId, 'player.connected');

    await waitFor(() => appended(frames).length > 0);
    expect(Date.now() - insertedAt).toBeLessThan(1500);
    expect(appended(frames)[0]?.data).toEqual({
      server_id: serverId,
      kinds: ['player.connected'],
    });
    ws.close();
  });

  it('coalesces a burst of rows into one frame per server with every kind', async () => {
    const { ws, frames } = await openSocket();
    const a = await makeServer();
    const b = await makeServer();
    await insertEvent(a, 'combat_damage');
    await insertEvent(a, 'combat_damage');
    await insertEvent(a, 'combat_death');
    await insertEvent(b, 'match.started');
    await insertEvent(null, 'bansync.completed');

    await waitFor(() => appended(frames).length >= 3);
    await new Promise((r) => setTimeout(r, 150));
    const byServer = new Map(appended(frames).map((f) => [f.data.server_id, f.data.kinds]));
    expect(appended(frames)).toHaveLength(3);
    expect(byServer.get(a)).toEqual(['combat_damage', 'combat_death']);
    expect(byServer.get(b)).toEqual(['match.started']);
    expect(byServer.get(null)).toEqual(['bansync.completed']);
    ws.close();
  });
});
