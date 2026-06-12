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
  onStatus: (cb: (state: 'connected' | 'disconnected') => void) => (() => void) | void;
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

type RnEventHandler = (raw: Record<string, unknown>) => void;

// In production mode the sidecar replaces only the legacy log pipeline (D4),
// and the panel's strict envelope schema rejects types outside its enum —
// so the real stream receives the legacy-parity types only. Shadow mode
// publishes everything for parity analysis and future expansion.
const PRODUCTION_TYPES = new Set([
  'player.connected',
  'player.disconnected',
  'match.started',
  'match.ended',
]);

export async function startPanelBridge(
  ctx: PanelBridgeContext,
): Promise<{ stop: () => Promise<void> }> {
  const mode: Mode = process.env.PANEL_BRIDGE_MODE === 'production' ? 'production' : 'shadow';
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');
  const publisher = new RedisPublisher(redis, ctx.serverId, mode);
  const heartbeat = new Heartbeat(redis, ctx.serverId);

  let stopped = false;
  const eventHandlers: Array<[(typeof RN_EVENTS)[number], RnEventHandler]> = [];

  for (const evt of RN_EVENTS) {
    const handler: RnEventHandler = (raw) => {
      if (stopped) return;
      const envelope = mapEvent(ctx.serverId, evt, raw);
      if (!envelope) return;
      if (mode === 'production' && !PRODUCTION_TYPES.has(envelope.type)) return;
      publisher.publishEvent(envelope).catch((err) => {
        console.error('panelBridge publishEvent', err);
      });
    };
    ctx.emitter.on(evt, handler);
    eventHandlers.push([evt, handler]);
  }

  const unsubscribeStatus = ctx.onStatus((state) => {
    if (stopped) return;
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
      stopped = true;
      for (const [evt, handler] of eventHandlers) {
        ctx.emitter.off(evt, handler);
      }
      eventHandlers.length = 0;
      unsubscribeStatus?.();
      heartbeat.stop();
      await rconServer?.close();
      await redis.quit();
    },
  };
}
