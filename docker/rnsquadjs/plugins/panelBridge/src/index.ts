import type { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { mapEvent } from './eventMap';
import { Heartbeat } from './heartbeat';
import { RconUnixServer } from './rconUnixServer';
import { type Mode, RedisPublisher } from './redisPublisher';

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
  // Without an 'error' listener, ioredis logs an unhandled-error warning on
  // every reconnect attempt while Redis is down and, worse, queues every
  // command issued in the meantime in an unbounded in-memory offline queue —
  // for the high-frequency game events this plugin publishes, that queue
  // grows without bound until maxRetriesPerRequest gives up. Disabling the
  // offline queue makes a command issued while disconnected reject
  // immediately instead, which the existing `.catch(err => console.error(...))`
  // call sites below already handle: an event is dropped and logged rather
  // than piling up.
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', (err) => console.error('panelBridge redis', err));
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
    try {
      await rconServer.listen();
    } catch (err) {
      // Undo everything set up above (event/status subscriptions, the Redis
      // connection) so a bind failure (EACCES/EADDRINUSE) doesn't leave a
      // half-started bridge publishing to the live stream with no heartbeat
      // and no working rcon channel — the caller's catch (panelBridge.ts)
      // only removes the activeBridges entry, it doesn't unwind this.
      for (const [evt, handler] of eventHandlers) {
        ctx.emitter.off(evt, handler);
      }
      eventHandlers.length = 0;
      unsubscribeStatus?.();
      await redis.quit().catch(() => {});
      throw err;
    }
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
