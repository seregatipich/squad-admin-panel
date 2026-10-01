import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import diagPlugin from '../src/lib/diag.js';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import liveRoutes from '../src/routes/live.js';
import { wsRoundTrip } from './helpers/ws-round-trip.js';

let app: FastifyInstance;
let port: number;

const SERVER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';
const COMBAT_VIEW_HEADER = 'x-test-combat-view';

function combat(occurredAt: string): LiveEvent {
  return {
    type: 'combat.event',
    ts: occurredAt,
    data: {
      server_id: SERVER_ID,
      match_id: null,
      kind: 'combat_death',
      attacker_player_id: 'attacker-1',
      victim_player_id: 'victim-1',
      weapon: 'BP_AK74',
      damage: 100,
      is_teamkill: false,
      is_suicide: false,
      occurred_at: occurredAt,
    },
  };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('redis', { xadd: async () => '0-0' });
  // Fake auth: the test client opts into combat:view via a request header so
  // we can exercise the per-event gate without a real session/DB round trip.
  app.addHook('preHandler', async (req) => {
    const header = req.headers[COMBAT_VIEW_HEADER];
    if (header === undefined) return;
    req.user = {
      playerId: 'test-player',
      permissions: { combatView: header === 'true' },
    } as typeof req.user;
  });
  await app.register(await import('@fastify/websocket').then((m) => m.default));
  await app.register(diagPlugin);
  await app.register(liveBusPlugin);
  await app.register(liveRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterAll(async () => {
  await app.close();
});

type CombatFrame = Extract<LiveEvent, { type: 'combat.event' }>;

async function connect(combatView?: boolean): Promise<{ ws: WebSocket; received: CombatFrame[] }> {
  const headers =
    combatView === undefined ? undefined : { [COMBAT_VIEW_HEADER]: String(combatView) };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`, { headers });
  const received: CombatFrame[] = [];
  let subscribed = false;
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as LiveEvent | { type: 'subscribed' };
    if (frame.type === 'subscribed') subscribed = true;
    if (frame.type === 'combat.event') received.push(frame);
  });
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  // combat.event is opt-in (#69): the client subscribes, and the tail is replayed then.
  ws.send(JSON.stringify({ type: 'subscribe', events: ['combat.event'] }));
  await waitFor(() => subscribed);
  return { ws, received };
}

async function close(ws: WebSocket): Promise<void> {
  ws.close();
  await new Promise<void>((resolve) => ws.on('close', () => resolve()));
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Connects a socket and records the type of every frame it receives. */
async function connectRecordingTypes(
  combatView: boolean,
): Promise<{ ws: WebSocket; types: string[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`, {
    headers: { [COMBAT_VIEW_HEADER]: String(combatView) },
  });
  const types: string[] = [];
  ws.on('message', (raw) => {
    types.push((JSON.parse(raw.toString()) as { type: string }).type);
  });
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  return { ws, types };
}

describe('/api/v1/ws/live combat replay buffer', () => {
  it('forwards live combat.event events to a socket with combat:view', async () => {
    const { ws, received } = await connect(true);
    app.liveBus.publish(combat('2026-07-09T11:00:00.000Z'));
    await waitFor(() => received.length > 0);
    expect(received[0]?.data.occurred_at).toBe('2026-07-09T11:00:00.000Z');
    await close(ws);
  });

  it('replays the buffered combat tail to a socket that subscribes after events were sent', async () => {
    app.liveBus.publish(combat('2026-07-09T11:01:00.000Z'));
    app.liveBus.publish(combat('2026-07-09T11:01:01.000Z'));

    const { ws, received } = await connect(true);
    await waitFor(() => received.some((e) => e.data.occurred_at === '2026-07-09T11:01:01.000Z'));
    const timestamps = received.map((e) => e.data.occurred_at);
    expect(timestamps).toContain('2026-07-09T11:01:00.000Z');
    expect(timestamps).toContain('2026-07-09T11:01:01.000Z');
    await close(ws);
  });

  it('a reconnecting client with combat:view still receives the tail it would otherwise miss', async () => {
    app.liveBus.publish(combat('2026-07-09T11:02:00.000Z'));
    const first = await connect(true);
    await waitFor(() =>
      first.received.some((e) => e.data.occurred_at === '2026-07-09T11:02:00.000Z'),
    );
    await close(first.ws);

    const second = await connect(true);
    await waitFor(() =>
      second.received.some((e) => e.data.occurred_at === '2026-07-09T11:02:00.000Z'),
    );
    await close(second.ws);
  });

  it('does not deliver combat.event live or via tail replay to a user without combat:view', async () => {
    app.liveBus.publish(combat('2026-07-09T11:03:00.000Z'));

    const { ws, received } = await connect(false);
    app.liveBus.publish(combat('2026-07-09T11:03:01.000Z'));
    await wsRoundTrip(ws);
    expect(received).toHaveLength(0);
    await close(ws);
  });

  it('does not deliver combat.event to a connection with no authenticated user', async () => {
    const { ws, received } = await connect();
    app.liveBus.publish(combat('2026-07-09T11:04:00.000Z'));
    await wsRoundTrip(ws);
    expect(received).toHaveLength(0);
    await close(ws);
  });

  it('withholds combat.vehicle frames from a socket without combat:view (#37)', async () => {
    const vehicle: LiveEvent = {
      type: 'combat.vehicle',
      ts: '2026-07-09T11:04:00.000Z',
      data: {
        server_id: SERVER_ID,
        match_id: null,
        kind: 'vehicle_destroyed',
        attacker_player_id: 'attacker-1',
        victim_vehicle: 'BP_BTR80',
        attacker_vehicle: null,
        weapon: 'BP_RPG7',
        damage: 1500,
        occurred_at: '2026-07-09T11:04:00.000Z',
      },
    };
    const denied = await connectRecordingTypes(false);
    const allowed = await connectRecordingTypes(true);
    // `combat.vehicle` is an opt-in frame (routes/live.ts, #40): both sockets ask for it,
    // and only the combat:view one may get it.
    const subscribe = JSON.stringify({ type: 'subscribe', events: ['combat.vehicle'] });
    denied.ws.send(subscribe);
    allowed.ws.send(subscribe);
    await waitFor(
      () => allowed.types.includes('subscribed') && denied.types.includes('subscribed'),
    );

    app.liveBus.publish(vehicle);
    await waitFor(() => allowed.types.includes('combat.vehicle'));
    await wsRoundTrip(denied.ws);

    expect(denied.types).not.toContain('combat.vehicle');
    await close(denied.ws);
    await close(allowed.ws);
  });
});
