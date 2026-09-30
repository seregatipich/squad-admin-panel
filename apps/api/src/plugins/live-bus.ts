import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fp from 'fastify-plugin';
import { z } from 'zod';

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
          | 'crash_loop'
          | 'external';
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
      /**
       * New rows landed in `events` (see plugins/events-feed.ts). Carries no
       * row data: open event lists refetch through the permission-checked
       * REST route. `server_id` is null for global events.
       */
      type: 'server.events.appended';
      ts: string;
      data: { server_id: string | null; kinds: string[] };
    }
  | {
      type: 'rcon.roster';
      ts: string;
      data: { server_id: string; player_count: number; polled_at: string };
    }
  | {
      type: 'server.seeding';
      ts: string;
      data: {
        server_id: string;
        state: 'seeding' | 'live';
        current_players: number;
        live_at: number;
        progress_pct: number;
        started_at: string | null;
        layer: string | null;
      };
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
      /** A note was edited; carries the whole edited note (#449). */
      type: 'note.updated';
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
      /** A note was (soft-)deleted (#449). */
      type: 'note.deleted';
      ts: string;
      data: { player_id: string; note_id: string };
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
        source: 'log' | 'rcon' | 'panel';
      };
    }
  | {
      type: 'combat.event';
      ts: string;
      data: {
        server_id: string;
        match_id: string | null;
        kind: 'combat_damage' | 'combat_wound' | 'combat_death' | 'combat_revive';
        attacker_player_id: string | null;
        victim_player_id: string | null;
        weapon: string | null;
        damage: number | null;
        is_teamkill: boolean;
        is_suicide: boolean;
        occurred_at: string;
      };
    }
  | {
      /**
       * A vehicle was damaged or destroyed; published by log-ingest
       * (`apps/workers/log-ingest/src/combat/store.ts`). Gated like
       * `combat.event`: only sockets with combat:view receive it.
       */
      type: 'combat.vehicle';
      ts: string;
      data: {
        server_id: string;
        match_id: string | null;
        kind: 'vehicle_destroyed' | 'vehicle_damage';
        attacker_player_id: string | null;
        victim_vehicle: string;
        attacker_vehicle: string | null;
        weapon: string | null;
        damage: number | null;
        occurred_at: string;
      };
    }
  | {
      type: 'vote.ended';
      ts: string;
      data: {
        vote_id: string;
        vote_type: string;
        initiator_player_id: string | null;
        map_current: string | null;
        map_next: string | null;
        map_target: string | null;
        votes_collected: number;
        votes_required: number;
        result: string | null;
        started_at: string;
        ended_at: string;
      };
    }
  | {
      type: 'report.created';
      ts: string;
      data: { report: ReportLiveView };
    }
  | {
      type: 'report.updated';
      ts: string;
      data: { report: ReportLiveView };
    }
  | {
      type: 'appeal.created';
      ts: string;
      data: { appeal_id: string; number: number; status: string };
    }
  | {
      type: 'appeal.updated';
      ts: string;
      data: { appeal_id: string; number: number; status: string };
    }
  | {
      type: 'server.map.changed';
      ts: string;
      data: { server_id: string; action: string; layer: string | null };
    }
  | {
      type: 'externalban.matched';
      ts: string;
      data: {
        server_id: string;
        player_id: string | null;
        source_id: string;
        external_ban_id: string;
        steam_id64: string;
        eos_id: string | null;
        name: string;
        source_name: string;
        reason: string | null;
        action: 'none' | 'alert' | 'kick';
        kick_enqueued?: boolean;
      };
    }
  | {
      /**
       * A file arrived through a one-time delegated-upload link (VIDEO-3,
       * #159). `player_id` is the admin who minted the token, and `live.ts`
       * delivers the frame only to that admin's own sockets.
       */
      type: 'media.uploaded';
      ts: string;
      data: {
        player_id: string | null;
        media_id: string;
        token_id: string;
        target_entity_type: 'player' | 'moderation_action' | 'match' | 'issue' | null;
        target_entity_id: string | null;
      };
    }
  | {
      type: 'alert.triggered';
      ts: string;
      data: Record<string, unknown>;
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

export interface ReportLiveView {
  id: string;
  server_id: string;
  reporter_player_id: string | null;
  target_player_id: string | null;
  target_raw: string | null;
  body: string;
  source: 'ingame' | 'ui';
  status: 'pending' | 'in_review' | 'resolved' | 'rejected';
  handler_player_id: string | null;
  resolution_note: string | null;
  created_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
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

/**
 * Which sockets may receive a LiveEvent type over `/api/v1/ws/live`:
 * `server` needs only the connection's baseline `server:view`, `combat` also
 * needs combat:view. `satisfies` makes the map list every LiveEvent type and
 * nothing else, so it is also the allow-list of types accepted from Redis.
 * `routes/live.ts` applies further per-type filters on top (session,
 * role-expiry and media frames).
 */
export const LIVE_EVENT_AUDIENCE = {
  'server.status': 'server',
  'server.deleted': 'server',
  'server.restored': 'server',
  'rcon.status': 'server',
  'server.events.appended': 'server',
  'rcon.roster': 'server',
  'server.seeding': 'server',
  'bridge.connection': 'server',
  'worker.heartbeat': 'server',
  'note.created': 'server',
  'note.updated': 'server',
  'note.deleted': 'server',
  'mark_type.changed': 'server',
  'session.revoked': 'server',
  'issue.created': 'server',
  'issue.updated': 'server',
  'issue.comment.created': 'server',
  'mark.changed': 'server',
  'chat.message': 'server',
  'combat.event': 'combat',
  'combat.vehicle': 'combat',
  'vote.ended': 'server',
  'report.created': 'server',
  'report.updated': 'server',
  'appeal.created': 'server',
  'appeal.updated': 'server',
  'server.map.changed': 'server',
  'externalban.matched': 'server',
  'media.uploaded': 'server',
  'alert.triggered': 'server',
} as const satisfies Record<LiveEvent['type'], 'server' | 'combat'>;

function isLiveEventType(type: unknown): type is LiveEvent['type'] {
  return typeof type === 'string' && Object.hasOwn(LIVE_EVENT_AUDIENCE, type);
}

/**
 * Checks the envelope of a frame read from the Redis `live-bus` channel:
 * workers publish there without the API's types, so a frame is forwarded only
 * when its `type` is a known LiveEvent type, `ts` is a string and `data` an
 * object (#37). The per-type payload shape is not validated.
 */
function toLiveFrame(frame: unknown): (LiveEvent & { _origin?: string }) | null {
  if (typeof frame !== 'object' || frame === null) return null;
  const { type, ts, data } = frame as { type?: unknown; ts?: unknown; data?: unknown };
  if (!isLiveEventType(type) || typeof ts !== 'string') return null;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  return frame as LiveEvent & { _origin?: string };
}

const LIVE_BUS_CHANNEL = 'live-bus';
const RCON_STATUS_CHANNEL = 'rcon:status:changed';

/** Shape of an `rcon:status:changed` message; checked rather than cast (#1301). */
const rconStatusMessage = z.object({
  server_id: z.string().min(1),
  state: z.string().min(1),
  player_count: z.number().optional(),
});

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export default fp(async (app) => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(1024);

  // Identifies events this instance already delivered to local subscribers
  // via `localEmit`, so the Redis round-trip echo of our own publish (this
  // instance is both publisher and subscriber of LIVE_BUS_CHANNEL) can be
  // recognized and skipped instead of delivering every local publish twice.
  // Events tagged with another instance's id (or untagged, e.g. published
  // directly by a worker) are still emitted for cross-process fan-out.
  const instanceId = randomUUID();

  const localEmit = (event: LiveEvent) => emitter.emit('event', event);
  // Types already reported as dropped, so a worker publishing an unknown type
  // on every tick logs it once instead of flooding the log.
  const droppedFrameTypes = new Set<string>();

  let subscriber: ReturnType<typeof app.redis.duplicate> | null = null;
  const canDuplicate = typeof app.redis?.duplicate === 'function';
  if (canDuplicate) {
    subscriber = app.redis.duplicate();
    subscriber.on('error', (err: Error) => {
      app.log.warn({ err: err.message }, 'live-bus subscriber error');
    });
    subscriber.on('message', (channel: string, raw: string) => {
      if (channel === LIVE_BUS_CHANNEL) {
        const parsed = parseJson(raw);
        const frame = toLiveFrame(parsed);
        if (!frame) {
          const type = (parsed as { type?: unknown } | null | undefined)?.type;
          const key = typeof type === 'string' ? type : '<malformed>';
          if (!droppedFrameTypes.has(key)) {
            droppedFrameTypes.add(key);
            app.log.warn(
              { type: key, raw: raw.slice(0, 200) },
              'live-bus: dropping frame that is not a known LiveEvent (logged once per type)',
            );
          }
          return;
        }
        const { _origin, ...evt } = frame;
        if (_origin === instanceId) return;
        localEmit(evt as LiveEvent);
        return;
      }
      if (channel === RCON_STATUS_CHANNEL) {
        const data = rconStatusMessage.safeParse(parseJson(raw));
        if (!data.success) {
          app.log.warn({ raw: raw.slice(0, 200) }, 'live-bus: dropped malformed rcon status');
          return;
        }
        localEmit({ type: 'rcon.status', ts: new Date().toISOString(), data: data.data });
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
        const wire = { ...event, _origin: instanceId };
        app.redis.publish(LIVE_BUS_CHANNEL, JSON.stringify(wire)).catch((err: Error) => {
          app.log.warn({ err: err.message }, 'live-bus: redis publish failed');
        });
      }
    },
    subscribe(cb) {
      // EventEmitter delivers synchronously and stops at the first throw, so an
      // unguarded subscriber would starve the ones after it and, on a local
      // publish, fail the route that already committed its change.
      const handler = (event: LiveEvent) => {
        try {
          cb(event);
        } catch (err) {
          app.log.error(
            { err: (err as Error).message, type: event.type },
            'live-bus: subscriber threw',
          );
        }
      };
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
