import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { v7 as uuidv7 } from 'uuid';
import { DIAG_STREAM_KEY, DIAG_STREAM_MAXLEN, type DiagEvent } from './types.js';

export type * from './types.js';

export interface DiagDeps {
  redis: Pick<Redis, 'xadd'>;
  log: Pick<Logger, 'warn' | 'debug'>;
}

export interface Diag {
  emit(ev: DiagEvent): Promise<void>;
}

export function createDiag({ redis, log }: DiagDeps): Diag {
  return {
    async emit(ev: DiagEvent) {
      const id = uuidv7();
      const ts = new Date().toISOString();
      const payload = JSON.stringify(ev.payload ?? {});
      try {
        await redis.xadd(
          DIAG_STREAM_KEY,
          'MAXLEN',
          '~',
          DIAG_STREAM_MAXLEN,
          '*',
          'id',
          id,
          'ts',
          ts,
          'component',
          ev.component,
          'severity',
          ev.severity,
          'kind',
          ev.kind,
          ...(ev.serverId ? ['server_id', ev.serverId] : []),
          ...(ev.actorPlayerId ? ['actor_player_id', ev.actorPlayerId] : []),
          ...(ev.requestId ? ['request_id', ev.requestId] : []),
          'message',
          ev.message,
          'payload',
          payload,
        );
        log.debug?.({ diag_event: { id, ...ev } }, 'diag emitted');
      } catch (err) {
        log.warn(
          { diag_event: { id, ts, ...ev }, err: (err as Error).message },
          'diag emit failed; using pino fallback',
        );
      }
    },
  };
}
