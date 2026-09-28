import type { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { mapEvent } from './eventMap';
import { Heartbeat } from './heartbeat';
import { RconUnixServer } from './rconUnixServer';
import { type Mode, type RconStatus, RedisPublisher } from './redisPublisher';

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

/**
 * How often the last known RCON status is rewritten. RCON only reports state
 * *changes*, so without a periodic rewrite the status key (TTL
 * `STATUS_TTL_SECONDS`, see `./redisPublisher`) would lapse on any connection
 * stable for longer than its TTL, and the panel would report a healthy sidecar
 * as gone.
 */
const STATUS_REFRESH_MS = 10_000;

export async function startPanelBridge(
  ctx: PanelBridgeContext,
): Promise<{ stop: () => Promise<void> }> {
  const mode: Mode = process.env.PANEL_BRIDGE_MODE === 'production' ? 'production' : 'shadow';
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
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

  let lastStatus: RconStatus | undefined;
  const publishStatus = (status: RconStatus): void => {
    publisher.publishRconStatus(status).catch((err) => {
      console.error('panelBridge publishRconStatus', err);
    });
  };

  const unsubscribeStatus = ctx.onStatus((state) => {
    if (stopped) return;
    lastStatus = { state, lastChange: new Date().toISOString() };
    publishStatus(lastStatus);
  });

  // Keeps the key alive between changes; `lastChange` is left untouched so a
  // refresh never looks like a state transition.
  const statusRefresh = setInterval(() => {
    if (stopped || !lastStatus) return;
    publishStatus(lastStatus);
  }, STATUS_REFRESH_MS);

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
      clearInterval(statusRefresh);
      heartbeat.stop();
      await rconServer?.close();
      await redis.quit();
    },
  };
}
