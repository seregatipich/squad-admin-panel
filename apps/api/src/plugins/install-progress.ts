import { EventEmitter } from 'node:events';
import fp from 'fastify-plugin';

export interface ProgressLine {
  ts: string;
  step: string;
  stream?: 'stdout' | 'stderr';
  message: string;
}

export interface InstallProgressBus {
  publish(serverId: string, line: ProgressLine): void;
  subscribe(serverId: string, cb: (line: ProgressLine) => void): () => void;
  snapshot(serverId: string): ProgressLine[];
}

declare module 'fastify' {
  interface FastifyInstance {
    installProgress: InstallProgressBus;
  }
}

const MAX_PER_SERVER = 500;

export default fp(async (app) => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(256);
  const buffers = new Map<string, ProgressLine[]>();

  const bus: InstallProgressBus = {
    publish(serverId, line) {
      const buf = buffers.get(serverId) ?? [];
      buf.push(line);
      if (buf.length > MAX_PER_SERVER) buf.splice(0, buf.length - MAX_PER_SERVER);
      buffers.set(serverId, buf);
      emitter.emit(serverId, line);
    },
    subscribe(serverId, cb) {
      emitter.on(serverId, cb);
      return () => emitter.off(serverId, cb);
    },
    snapshot(serverId) {
      return (buffers.get(serverId) ?? []).slice();
    },
  };

  app.decorate('installProgress', bus);
});
