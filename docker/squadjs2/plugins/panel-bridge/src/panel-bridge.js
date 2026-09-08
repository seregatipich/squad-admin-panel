import { Redis } from 'ioredis';
import BasePlugin from './base-plugin.js';
import { buildEnvelope, MAPPED_EVENTS, mapEvent } from './panel-bridge/event-map.js';
import { Heartbeat } from './panel-bridge/heartbeat.js';
import { NameChangeTracker } from './panel-bridge/name-change-tracker.js';
import { RedisPublisher } from './panel-bridge/redis-publisher.js';

const POLL_EVENT = 'UPDATED_PLAYER_INFORMATION';
const RCON_ERROR_EVENT = 'RCON_ERROR';

/**
 * Publishes SquadJS2 server events onto the panel's Redis streams.
 *
 * This is the whole panel-facing surface of the sidecar: the panel never talks
 * to SquadJS2 directly. RCON stays owned by `worker-rcon` (deviation D4), so
 * the plugin only reads — it issues no commands and opens no sockets.
 */
export default class PanelBridge extends BasePlugin {
  static get description() {
    return (
      'Публикует события сервера в панельные Redis-стримы (events:server:{id}), ' +
      'статус сайдкара и heartbeat. Только чтение: RCON-командами владеет worker-rcon.'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      mode: {
        required: false,
        description:
          '`shadow` пишет в :shadow-ключи и публикует все типы; `production` пишет в боевые ключи только legacy-parity типы.',
        default: 'shadow',
      },
      redisUrl: {
        required: false,
        description: 'Redis панели.',
        default: 'redis://127.0.0.1:6379',
      },
      serverId: {
        required: true,
        description: 'UUID сервера в панели — префикс всех ключей.',
        default: null,
      },
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.mode = this.options.mode === 'production' ? 'production' : 'shadow';
    this.serverId = this.options.serverId;
    this.tracker = new NameChangeTracker();
    this.handlers = [];
    this.redis = null;
    this.publisher = null;
    this.heartbeat = null;
    this.stopped = true;
  }

  /**
   * Opens the panel Redis connection.
   *
   * Split out so unit tests can substitute a fake client without a live Redis;
   * production always gets a real ioredis client for `options.redisUrl`.
   *
   * @returns {import('ioredis').Redis} A connected client.
   */
  createRedis() {
    return new Redis(this.options.redisUrl);
  }

  async mount() {
    this.redis = this.createRedis();
    this.publisher = new RedisPublisher(this.redis, this.serverId, this.mode);
    this.heartbeat = new Heartbeat(this.redis, this.serverId, {
      onError: (err) => this.verbose(1, 'heartbeat tick failed', err),
    });
    this.stopped = false;

    for (const event of MAPPED_EVENTS) {
      this.#subscribe(event, (data) => {
        const envelope = mapEvent(this.serverId, event, data ?? {});
        if (envelope) this.#publish(envelope);
        if (event === 'PLAYER_DISCONNECTED') this.tracker.forget(data?.player);
      });
    }

    // SquadJS2 has no rename event; the panel derives one from the player-list
    // poll so banned-name enforcement works on sidecar servers.
    this.#subscribe(POLL_EVENT, () => {
      for (const change of this.tracker.diff(this.server.players)) {
        this.#publish(buildEnvelope(this.serverId, 'player.name_changed', new Date(), change));
      }
    });

    this.#subscribe(RCON_ERROR_EVENT, () => {
      this.#publishStatus('disconnected');
    });

    this.#publishStatus('connected');
    this.heartbeat.start();
  }

  async unmount() {
    this.stopped = true;
    for (const [event, handler] of this.handlers) this.server.removeListener(event, handler);
    this.handlers = [];
    this.heartbeat?.stop();
    this.heartbeat = null;
    this.publisher = null;
    if (this.redis) {
      const redis = this.redis;
      this.redis = null;
      await redis.quit();
    }
  }

  #subscribe(event, handler) {
    const guarded = (data) => {
      if (this.stopped) return;
      handler(data);
    };
    this.server.on(event, guarded);
    this.handlers.push([event, guarded]);
  }

  #publish(envelope) {
    this.publisher?.publishEvent(envelope).catch((err) => {
      this.verbose(1, 'publishEvent failed', err);
    });
  }

  #publishStatus(state) {
    this.publisher
      ?.publishRconStatus({ state, lastChange: new Date().toISOString() })
      .catch((err) => {
        this.verbose(1, 'publishRconStatus failed', err);
      });
  }
}
