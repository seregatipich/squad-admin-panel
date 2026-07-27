import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import diagPlugin from '../src/lib/diag.js';
import liveBusPlugin, { type LiveEvent } from '../src/plugins/live-bus.js';
import liveRoutes from '../src/routes/live.js';

const MINTER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee01';
const OTHER_ID = '019dbac8-ceb0-77ab-859b-bfa9a282ee02';

let app: ReturnType<typeof Fastify>;
let port: number;

/** Opens a live socket authenticated as `playerId` and collects every frame it receives. */
async function connectAs(playerId: string): Promise<{ frames: LiveEvent[]; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live?player=${playerId}`);
  const frames: LiveEvent[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as LiveEvent));
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  return { frames, close: () => ws.close() };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (app as any).decorate('redis', { xadd: async () => '0-0' });
  // Stand-in for the auth plugin: the live route only reads `req.user`, so a
  // query parameter is enough to exercise the per-player delivery filter.
  app.addHook('onRequest', async (req) => {
    const playerId = new URL(req.url, 'http://localhost').searchParams.get('player');
    if (!playerId) return;
    // biome-ignore lint/suspicious/noExplicitAny: minimal user stub
    (req as any).user = {
      playerId,
      permissions: { combatView: false, canAssignRoles: false },
    };
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

describe('media.uploaded live delivery', () => {
  it('delivers the event only to the minting admin socket', async () => {
    const minter = await connectAs(MINTER_ID);
    const other = await connectAs(OTHER_ID);

    const event: LiveEvent = {
      type: 'media.uploaded',
      ts: '2026-07-27T00:00:00.000Z',
      data: {
        player_id: MINTER_ID,
        media_id: '019dbac8-ceb0-77ab-859b-bfa9a282ee10',
        token_id: '019dbac8-ceb0-77ab-859b-bfa9a282ee11',
        target_entity_type: 'moderation_action',
        target_entity_id: '019dbac8-ceb0-77ab-859b-bfa9a282ee12',
      },
    };
    app.liveBus.publish(event);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(minter.frames.filter((f) => f.type === 'media.uploaded')).toEqual([event]);
    expect(other.frames.filter((f) => f.type === 'media.uploaded')).toEqual([]);

    minter.close();
    other.close();
  });

  it('drops the event for a socket with no authenticated player', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws/live`);
    const frames: LiveEvent[] = [];
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as LiveEvent));
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));

    app.liveBus.publish({
      type: 'media.uploaded',
      ts: '2026-07-27T00:00:00.000Z',
      data: {
        player_id: MINTER_ID,
        media_id: '019dbac8-ceb0-77ab-859b-bfa9a282ee20',
        token_id: '019dbac8-ceb0-77ab-859b-bfa9a282ee21',
        target_entity_type: null,
        target_entity_id: null,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(frames.filter((f) => f.type === 'media.uploaded')).toEqual([]);
    ws.close();
  });
});
