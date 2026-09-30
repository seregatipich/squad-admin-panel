import { EventEmitter } from 'node:events';
import fp from 'fastify-plugin';

export interface ProgressLine {
  ts: string;
  step: string;
  stream?: 'stdout' | 'stderr';
  message: string;
}

/**
 * In-process fan-out of install progress lines, with a bounded per-server
 * replay buffer so a WebSocket that connects mid-install sees what it missed.
 */
export interface InstallProgressBus {
  /** Buffers the line and delivers it to the server's subscribers. */
  publish(serverId: string, line: ProgressLine): void;
  /** Subscribes to one server's lines; returns the unsubscribe function. */
  subscribe(serverId: string, cb: (line: ProgressLine) => void): () => void;
  /** Copy of the buffered lines of one server, oldest first. */
  snapshot(serverId: string): ProgressLine[];
  /**
   * Drops the buffered lines of one server — called when a new install
   * starts, so its snapshot never replays the previous attempt, and when the
   * server is deleted.
   */
  reset(serverId: string): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    installProgress: InstallProgressBus;
  }
}

const MAX_PER_SERVER = 500;
/** How long a finished install's lines stay replayable after its final `done`/`error` line. */
export const INSTALL_PROGRESS_RETENTION_MS = 15 * 60_000;
const FINAL_STEPS = new Set(['done', 'error']);

export default fp(async (app) => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(256);
  const buffers = new Map<string, ProgressLine[]>();
  const evictionTimers = new Map<string, NodeJS.Timeout>();

  const cancelEviction = (serverId: string) => {
    const timer = evictionTimers.get(serverId);
    if (timer) clearTimeout(timer);
    evictionTimers.delete(serverId);
  };

  const bus: InstallProgressBus = {
    publish(serverId, line) {
      const buf = buffers.get(serverId) ?? [];
      buf.push(line);
      if (buf.length > MAX_PER_SERVER) buf.splice(0, buf.length - MAX_PER_SERVER);
      buffers.set(serverId, buf);
      if (FINAL_STEPS.has(line.step)) {
        cancelEviction(serverId);
        const timer = setTimeout(() => {
          evictionTimers.delete(serverId);
          buffers.delete(serverId);
        }, INSTALL_PROGRESS_RETENTION_MS);
        timer.unref();
        evictionTimers.set(serverId, timer);
      }
      emitter.emit(serverId, line);
    },
    subscribe(serverId, cb) {
      emitter.on(serverId, cb);
      return () => emitter.off(serverId, cb);
    },
    snapshot(serverId) {
      return (buffers.get(serverId) ?? []).slice();
    },
    reset(serverId) {
      cancelEviction(serverId);
      buffers.delete(serverId);
    },
  };

  app.decorate('installProgress', bus);
  app.addHook('onClose', async () => {
    for (const timer of evictionTimers.values()) clearTimeout(timer);
    evictionTimers.clear();
  });
});
