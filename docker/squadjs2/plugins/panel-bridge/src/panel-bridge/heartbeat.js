import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

/** Where the SquadJS2 image records the build it was made from. */
export const BUILD_IDENTITY_PATH = '/usr/share/squadjs/build-identity.json';

const INTERVAL_MS = 10_000;
const TTL_SECONDS = 30;

/**
 * Reads the base image's build commit, used as the sidecar's reported version.
 *
 * Replaces RNSquadJS's `UPSTREAM_SHA` env var: the SquadJS2 image bakes its own
 * identity in at build time, so the running container can report exactly which
 * verified release it is without the launcher having to pass anything.
 *
 * @param {string} [path] - Identity file location; overridable for tests.
 * @returns {string} The commit SHA, or `'unknown'` when it cannot be read.
 */
export function readBuildIdentityVersion(path = BUILD_IDENTITY_PATH) {
  try {
    const identity = JSON.parse(readFileSync(path, 'utf8'));
    const commitSha = identity?.commitSha;
    return typeof commitSha === 'string' && commitSha.length > 0 ? commitSha : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Periodic liveness key for the panel's worker-health view. */
export class Heartbeat {
  #timer;
  #stopped = false;
  #startedAt = new Date().toISOString();

  /**
   * @param {import('ioredis').Redis} redis - Connected client.
   * @param {string} serverId - Panel server UUID.
   * @param {{ version?: string, intervalMs?: number, onError?: (err: unknown) => void }} [options] -
   *   Reported version (defaults to the image build identity), tick interval,
   *   and an error sink so a failed tick never rejects into the event loop.
   */
  constructor(redis, serverId, options = {}) {
    this.redis = redis;
    this.serverId = serverId;
    this.version = options.version ?? readBuildIdentityVersion();
    this.intervalMs = options.intervalMs ?? INTERVAL_MS;
    this.onError = options.onError ?? (() => {});
  }

  /** Writes the first heartbeat immediately, then every interval. */
  start() {
    this.#stopped = false;
    void this.#runTick();
    this.#timer = setInterval(() => {
      void this.#runTick();
    }, this.intervalMs);
  }

  /** Cancels the timer; in-flight ticks become no-ops. */
  stop() {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #runTick() {
    if (this.#stopped) return;
    try {
      await this.#tick();
    } catch (err) {
      this.onError(err);
    }
  }

  async #tick() {
    const payload = {
      name: `squadjs2:${this.serverId}`,
      ts: new Date().toISOString(),
      pid: process.pid,
      hostname: hostname(),
      version: this.version,
      started_at: this.#startedAt,
      status: 'ok',
    };
    await this.redis.set(
      `worker:heartbeat:sidecar:${this.serverId}`,
      JSON.stringify(payload),
      'EX',
      TTL_SECONDS,
    );
  }
}
