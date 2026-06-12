import type { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { mapEvent } from './eventMap.js';
import { Heartbeat } from './heartbeat.js';
import { RconUnixServer } from './rconUnixServer.js';
import { type Mode, RedisPublisher } from './redisPublisher.js';

export interface PanelBridgeContext {
  serverId: string;
  emitter: EventEmitter;
  rconExec: (method: string, args: unknown[]) => Promise<string>;
  onStatus: (cb: (state: 'connected' | 'disconnected') => void) => void;
}

const RN_EVENTS = [
  'PLAYER_CONNECTED',
  'PLAYER_DISCONNECTED',
  'PLAYER_DAMAGED',
  'PLAYER_DIED',
  'PLAYER_WOUNDED',
  'PLAYER_REVIVED',
  'PLAYER_POSSESS',
  'PLAYER_UNPOSSESS',
  'NEW_GAME',
  'ROUND_ENDED',
  'SQUAD_CREATED',
  'DEPLOYABLE_DAMAGED',
  'TICK_RATE',
  'ADMIN_BROADCAST',
  'CHAT_MESSAGE',
  'POSSESSED_ADMIN_CAMERA',
  'UNPOSSESSED_ADMIN_CAMERA',
] as const;

export async function startPanelBridge(
  ctx: PanelBridgeContext,
): Promise<{ stop: () => Promise<void> }> {
  const mode: Mode = process.env.PANEL_BRIDGE_MODE === 'production' ? 'production' : 'shadow';
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');
  const publisher = new RedisPublisher(redis, ctx.serverId, mode);
  const heartbeat = new Heartbeat(redis, ctx.serverId);

  for (const evt of RN_EVENTS) {
    ctx.emitter.on(evt, (raw: Record<string, unknown>) => {
      const envelope = mapEvent(ctx.serverId, evt, raw);
      if (!envelope) return;
      publisher.publishEvent(envelope).catch((err) => {
        console.error('panelBridge publishEvent', err);
      });
    });
  }

  ctx.onStatus((state) => {
    publisher.publishRconStatus({ state, lastChange: new Date().toISOString() }).catch((err) => {
      console.error('panelBridge publishRconStatus', err);
    });
  });

  let rconServer: RconUnixServer | undefined;
  if (mode === 'production') {
    rconServer = new RconUnixServer(
      process.env.PANEL_BRIDGE_SOCKET ?? '/run/panelBridge/rcon.sock',
      ctx.rconExec,
    );
    await rconServer.listen();
  }

  heartbeat.start();

  return {
    stop: async () => {
      heartbeat.stop();
      await rconServer?.close();
      await redis.quit();
    },
  };
}
