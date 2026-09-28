import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket, connect as tcpConnect } from 'node:net';
import { events, servers } from '@squad/db/schema';
import type { DiagEvent } from '@squad/diag';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import diagPlugin from '../../src/lib/diag.js';
import eventsFeedPlugin from '../../src/plugins/events-feed.js';
import liveBusPlugin, { type LiveEvent } from '../../src/plugins/live-bus.js';
import { hostDbUrl } from './isolated-db.js';

/**
 * #73 — Postgres is unreachable when the API boots. The feed must keep
 * retrying LISTEN and start delivering once the database answers, instead of
 * staying dead until the process restarts. A local TCP proxy stands in for
 * the database: closed at boot, then opened in front of the real Postgres.
 */

let app: FastifyInstance | undefined;
let proxy: Server | undefined;
const proxySockets = new Set<Socket>();

afterEach(async () => {
  await app?.close();
  for (const socket of proxySockets) socket.destroy();
  await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
  app = undefined;
  proxy = undefined;
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const addr = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

function startProxy(port: number, target: URL): Promise<Server> {
  const server = createServer((client) => {
    proxySockets.add(client);
    const upstream = tcpConnect(Number(target.port || 5432), target.hostname);
    proxySockets.add(upstream);
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('events feed LISTEN retry (#73)', () => {
  it('recovers the live feed when Postgres comes up after boot', async () => {
    const target = new URL(hostDbUrl());
    const port = await freePort();
    const viaProxy = new URL(target.toString());
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(port);

    app = Fastify({ logger: false });
    // biome-ignore lint/suspicious/noExplicitAny: test fixture — redis stub without pub/sub
    (app as any).decorate('redis', { xadd: async () => '0-0' });
    await app.register(diagPlugin);
    const diagEvents: DiagEvent[] = [];
    app.diag.emit = async (ev) => {
      diagEvents.push(ev);
    };
    await app.register(liveBusPlugin);
    await app.register(eventsFeedPlugin, {
      databaseUrl: viaProxy.toString(),
      debounceMs: 20,
      retryBaseMs: 50,
      retryMaxMs: 200,
    });
    await app.ready();
    const frames: LiveEvent[] = [];
    app.liveBus.subscribe((event) => frames.push(event));

    await waitFor(() => diagEvents.some((e) => e.kind === 'events_feed.listen_failed'));
    proxy = await startProxy(port, target);
    await waitFor(() => diagEvents.some((e) => e.kind === 'events_feed.listen_recovered'));

    const sql = postgres(hostDbUrl(), { max: 1, onnotice: () => undefined });
    try {
      const serverId = randomUUID();
      const slug = `feed-retry-${serverId.slice(0, 8)}`;
      await drizzle(sql)
        .insert(servers)
        .values({ id: serverId, displayName: slug, slug, status: 'running' });
      await drizzle(sql).insert(events).values({
        eventId: randomUUID(),
        serverId,
        occurredAt: new Date(),
        kind: 'player.connected',
        version: 1,
        actorKind: 'system',
        payload: {},
      });
      await waitFor(() =>
        frames.some((f) => f.type === 'server.events.appended' && f.data.server_id === serverId),
      );
    } finally {
      await sql.end();
    }
    expect(diagEvents.filter((e) => e.kind === 'events_feed.listen_failed')).toHaveLength(1);
  });
});
