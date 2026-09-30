import type { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { isPublishablePayload, type KnownPlayer, mapEvent, type PlayerLookup } from './eventMap';
import { Heartbeat } from './heartbeat';
import { type Mode, type RconStatus, RedisPublisher } from './redisPublisher';

export interface PanelBridgeContext {
  serverId: string;
  emitter: EventEmitter;
  onStatus: (cb: (state: 'connected' | 'disconnected') => void) => (() => void) | void;
  /**
   * Looks up an online player in RNSquadJS's `state.players` by lower-case
   * EOS id. Optional: without it only identities remembered from earlier
   * connect events resolve.
   */
  findPlayer?: PlayerLookup;
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

  // RNSquadJS re-polls ListPlayers on a timer, so by the time a disconnect is
  // logged the player may already be gone from `state.players`. Identities
  // resolved at connect are kept until that player's disconnect so the
  // disconnect can still carry its steam id; the map holds one entry per
  // online player (plus any whose disconnect line was never logged).
  const connectedPlayers = new Map<string, KnownPlayer>();
  const findPlayer: PlayerLookup = (eosId) =>
    ctx.findPlayer?.(eosId) ?? connectedPlayers.get(eosId);

  const trackIdentity = (type: string, payload: Record<string, unknown>): void => {
    const { eos_id: eosId, steam_id64: steamID, name } = payload;
    if (typeof eosId !== 'string') return;
    if (type === 'player.disconnected') {
      connectedPlayers.delete(eosId);
      return;
    }
    if (type === 'player.connected' && typeof steamID === 'string' && typeof name === 'string') {
      connectedPlayers.set(eosId, { steamID, name });
    }
  };

  for (const evt of RN_EVENTS) {
    const handler: RnEventHandler = (raw) => {
      if (stopped) return;
      const envelope = mapEvent(ctx.serverId, evt, raw, findPlayer);
      if (!envelope) return;
      trackIdentity(envelope.type, envelope.payload);
      if (mode === 'production' && !PRODUCTION_TYPES.has(envelope.type)) return;
      // Production consumers validate against the strict shared schemas; an
      // event without a resolvable player identity would be rejected there.
      if (mode === 'production' && !isPublishablePayload(envelope)) {
        console.warn('panelBridge dropped unpublishable event', envelope.type, envelope.payload);
        return;
      }
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
      await redis.quit();
    },
  };
}
