import { EventEmitter } from 'node:events';
import fp from 'fastify-plugin';

export type LiveEvent =
  | {
      type: 'server.status';
      ts: string;
      data: {
        server_id: string;
        status: string;
        source:
          | 'reconciler'
          | 'install'
          | 'delete'
          | 'stop'
          | 'start'
          | 'restart'
          | 'force_stop'
          | 'crash_detected'
          | 'crash_loop';
      };
    }
  | {
      type: 'server.deleted';
      ts: string;
      data: { server_id: string; deleted_at: string; by: string | null };
    }
  | {
      type: 'server.restored';
      ts: string;
      data: { old_server_id: string; new_server_id: string };
    }
  | {
      type: 'rcon.status';
      ts: string;
      data: { server_id: string; state: string; player_count?: number };
    }
  | {
      type: 'bridge.connection';
      ts: string;
      data: { state: 'up' | 'down'; down_for_s: number };
    }
  | {
      type: 'worker.heartbeat';
      ts: string;
      data: { worker: string; healthy: boolean };
    }
  | {
      type: 'note.created';
      ts: string;
      data: {
        player_id: string;
        note: {
          id: string;
          player_id: string;
          author: { id: string; name: string; role_color: string | null };
          body: string;
          created_at: string;
          updated_at: string | null;
          edited: boolean;
        };
      };
    }
  | {
      type: 'mark_type.changed';
      ts: string;
      data: { action: 'created' | 'updated' | 'reordered' };
    }
  | {
      type: 'session.revoked';
      ts: string;
      data: { player_id: string; session_id: string };
    }
  | {
      type: 'issue.created';
      ts: string;
      data: { issue: IssueLiveView };
    }
  | {
      type: 'issue.updated';
      ts: string;
      data: { issue: IssueLiveView };
    }
  | {
      type: 'issue.comment.created';
      ts: string;
      data: { issue_id: string; comment: IssueCommentLiveView };
    }
  | {
      type: 'mark.changed';
      ts: string;
      data: {
        player_id: string;
        action: 'set' | 'cleared';
        mark: {
          id: string;
          player_id: string;
          mark_type_id: number;
          comment: string | null;
          created_by: string;
          created_by_name: string | null;
          created_at: string;
          cleared_by: string | null;
          cleared_by_name: string | null;
          cleared_at: string | null;
          clear_reason: string | null;
          active: boolean;
          mark_type: {
            id: number;
            slug: string;
            label_en: string;
            label_ru: string;
            icon: string;
            severity: number;
          };
        };
      };
    }
  | {
      type: 'chat.message';
      ts: string;
      data: {
        id: string;
        server_id: string;
        ts: string;
        channel: 'ChatAll' | 'ChatTeam' | 'ChatSquad' | 'ChatAdmin';
        player_id: string | null;
        player_name: string;
        steam_id64: string | null;
        eos_id: string | null;
        message: string;
      };
    };

export interface IssuePlayerRef {
  id: string;
  name: string;
}

export interface IssueLabelRef {
  id: string;
  name: string;
  color: string;
}

export interface IssueLiveView {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'in_progress' | 'closed';
  author_player_id: string;
  assignee_player_id: string | null;
  author: IssuePlayerRef | null;
  assignee: IssuePlayerRef | null;
  labels: IssueLabelRef[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface IssueCommentLiveView {
  id: string;
  issue_id: string;
  author_player_id: string;
  author: IssuePlayerRef | null;
  body: string;
  created_at: string;
}

export interface LiveBus {
  publish(event: LiveEvent): void;
  subscribe(cb: (event: LiveEvent) => void): () => void;
}

declare module 'fastify' {
  interface FastifyInstance {
    liveBus: LiveBus;
  }
}

const LIVE_BUS_CHANNEL = 'live-bus';
const RCON_STATUS_CHANNEL = 'rcon:status:changed';

export default fp(async (app) => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(1024);

  const localEmit = (event: LiveEvent) => emitter.emit('event', event);

  let subscriber: ReturnType<typeof app.redis.duplicate> | null = null;
  const canDuplicate = typeof app.redis?.duplicate === 'function';
  if (canDuplicate) {
    subscriber = app.redis.duplicate();
    subscriber.on('error', (err: Error) => {
      app.log.warn({ err: err.message }, 'live-bus subscriber error');
    });
    subscriber.on('message', (channel: string, raw: string) => {
      if (channel === LIVE_BUS_CHANNEL) {
        try {
          const evt = JSON.parse(raw) as LiveEvent;
          emitter.emit('event', evt);
        } catch (err) {
          app.log.warn(
            { err: (err as Error).message, raw: raw.slice(0, 200) },
            'live-bus: bad redis message',
          );
        }
        return;
      }
      if (channel === RCON_STATUS_CHANNEL) {
        try {
          const data = JSON.parse(raw) as {
            server_id: string;
            state: string;
            player_count?: number;
          };
          emitter.emit('event', {
            type: 'rcon.status',
            ts: new Date().toISOString(),
            data,
          } satisfies LiveEvent);
        } catch (err) {
          app.log.warn({ err: (err as Error).message }, 'live-bus: bad rcon status message');
        }
      }
    });
    try {
      await subscriber.subscribe(LIVE_BUS_CHANNEL, RCON_STATUS_CHANNEL);
    } catch (err) {
      app.log.warn(
        { err: (err as Error).message },
        'live-bus: redis subscribe failed; cross-process fan-out disabled',
      );
    }
  } else {
    app.log.warn('live-bus: redis client lacks duplicate(); running in single-process mode');
  }

  const liveBus: LiveBus = {
    publish(event) {
      localEmit(event);
      if (typeof app.redis?.publish === 'function') {
        app.redis.publish(LIVE_BUS_CHANNEL, JSON.stringify(event)).catch((err: Error) => {
          app.log.warn({ err: err.message }, 'live-bus: redis publish failed');
        });
      }
    },
    subscribe(cb) {
      const handler = (event: LiveEvent) => cb(event);
      emitter.on('event', handler);
      return () => emitter.off('event', handler);
    },
  };

  app.decorate('liveBus', liveBus);

  app.addHook('onClose', async () => {
    if (subscriber) {
      try {
        await subscriber.unsubscribe(LIVE_BUS_CHANNEL, RCON_STATUS_CHANNEL);
      } catch {
        /* noop */
      }
      try {
        await subscriber.quit();
      } catch {
        /* noop */
      }
    }
    emitter.removeAllListeners();
  });
});
