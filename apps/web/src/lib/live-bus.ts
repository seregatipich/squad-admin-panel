import { jitteredBackoffMs } from './ws-backoff';

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
       * New rows in `events`; the list refetches over REST (no row data here).
       * Match boundaries arrive this way too — as the `match.started` /
       * `match.ended` kinds — see {@link announcesMatchBoundary}.
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
      type: 'note.created';
      ts: string;
      data: { player_id: string; note: PlayerNote };
    }
  | {
      type: 'note.updated';
      ts: string;
      data: { player_id: string; note: PlayerNote };
    }
  | {
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
      data: { issue: IssueView };
    }
  | {
      type: 'issue.updated';
      ts: string;
      data: { issue: IssueView };
    }
  | {
      type: 'issue.comment.created';
      ts: string;
      data: { issue_id: string; comment: IssueComment };
    }
  | {
      type: 'mark.changed';
      ts: string;
      data: { player_id: string; action: 'set' | 'cleared'; mark: LivePlayerMark };
    }
  | {
      type: 'chat.message';
      ts: string;
      data: ChatMessage;
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
      data: VoteEndedData;
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
       * #159). The API delivers this frame only to the admin who minted the
       * link, so any socket that receives it is the intended recipient.
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

/** Event kinds log-ingest stores when a match starts or ends. */
const MATCH_BOUNDARY_KINDS: readonly string[] = ['match.started', 'match.ended'];

/**
 * Whether a `server.events.appended` batch announces a match start or end.
 *
 * The API publishes no dedicated match frame: log-ingest stores the boundary
 * in `events`, and the events feed announces it with its kind (#1315).
 *
 * @param batch `data` of the `server.events.appended` frame.
 * @param serverId When given, the batch must also belong to this server.
 */
export function announcesMatchBoundary(
  batch: { server_id: string | null; kinds: string[] },
  serverId?: string,
): boolean {
  if (serverId !== undefined && batch.server_id !== serverId) return false;
  return batch.kinds.some((kind) => MATCH_BOUNDARY_KINDS.includes(kind));
}

export type ReportStatus = 'pending' | 'in_review' | 'resolved' | 'rejected';

/** Reduced shape published over the live-bus WS for `report.created`/`report.updated`. */
export interface ReportLiveView {
  id: string;
  server_id: string;
  reporter_player_id: string | null;
  target_player_id: string | null;
  target_raw: string | null;
  body: string;
  source: 'ingame' | 'ui';
  status: ReportStatus;
  handler_player_id: string | null;
  resolution_note: string | null;
  created_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
}

/** A media file (MOD-3/VIDEO-1) attached to a report as evidence (REPORT-4). */
export interface ReportEvidenceItem {
  id: string;
  kind: 'video' | 'image' | 'external_link';
  external_url: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  title: string | null;
}

/** Full report view returned by GET /api/v1/reports (and /:id), with resolved names. */
export interface ReportListItem extends ReportLiveView {
  server_name: string | null;
  server_slug: string | null;
  reporter_name: string | null;
  target_name: string | null;
  handler_name: string | null;
  evidence: ReportEvidenceItem[];
  evidence_count: number;
  /**
   * Reporter trust / target-recidivism badges (REPORT-5, #115). Optional
   * because `report.updated` live-bus events only carry the reduced
   * {@link ReportLiveView} shape — ReportsBrowser merges those on top of the
   * already-loaded row, so these fields fall back to the prior value.
   */
  reporter_trusted?: boolean;
  reporter_spam_flagged?: boolean;
  target_report_count_90d?: number;
}

export interface VoteEndedData {
  vote_id: string;
  server_id: string;
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
}

export type ChatChannel = 'ChatAll' | 'ChatTeam' | 'ChatSquad' | 'ChatAdmin';

export interface ChatMessage {
  id: string;
  server_id: string;
  ts: string;
  channel: ChatChannel;
  player_id: string | null;
  player_name: string;
  steam_id64: string | null;
  eos_id: string | null;
  message: string;
  /** Which pipeline carried the line — same values the archive row's `source` uses. */
  source: 'log' | 'rcon' | 'panel';
}

export interface PlayerNote {
  id: string;
  player_id: string;
  author: { id: string; name: string; role_color: string | null };
  body: string;
  created_at: string;
  updated_at: string | null;
  edited: boolean;
}

export type IssueState = 'open' | 'in_progress' | 'closed';

export interface IssuePlayerRef {
  id: string;
  name: string;
}

export interface IssueLabel {
  id: string;
  name: string;
  color: string;
}

export interface IssueView {
  id: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  author_player_id: string;
  assignee_player_id: string | null;
  author: IssuePlayerRef | null;
  assignee: IssuePlayerRef | null;
  labels: IssueLabel[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface IssueComment {
  id: string;
  issue_id: string;
  author_player_id: string;
  author: IssuePlayerRef | null;
  body: string;
  created_at: string;
}

export interface LivePlayerMark {
  player_id: string;
  mark_type_id: number;
  comment: string | null;
  created_by: string;
  created_by_name: string | null;
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
}

export type LiveBusState = 'connecting' | 'open' | 'closed';

export interface LiveBusHandle {
  /**
   * Receive every event this socket is sent. Pass `eventType` to also declare
   * interest in that type: the API pushes high-volume types (chat, combat,
   * roster snapshots) only to sockets that subscribed to them, and replays the
   * chat/combat tail on subscribe. The subscription is reference-counted and
   * re-sent after every reconnect.
   */
  subscribe(cb: (event: LiveEvent) => void, eventType?: LiveEvent['type']): () => void;
  state(): LiveBusState;
  onStateChange(cb: (state: LiveBusState) => void): () => void;
  /** Force the singleton's WS connection to be opened (or kept alive)
   *  while the caller is mounted, even with no subscribers. Returns a
   *  release function — call it in the cleanup of useEffect to allow
   *  idle-close. Calling the release function more than once is harmless. */
  retain(): () => void;
  /** Tear down the current socket and immediately reopen. Used by the
   *  ConnectionBanner's manual "Переподключить" button to bypass the
   *  exponential backoff loop after a long disconnection. */
  forceReconnect(): void;
}

const IDLE_CLOSE_DELAY_MS = 5_000;

let singleton: LiveBusHandle | null = null;

function makeLiveBus(): LiveBusHandle {
  const eventSubs = new Set<(event: LiveEvent) => void>();
  const stateSubs = new Set<(state: LiveBusState) => void>();
  /** Declared interest per event type; the server is told on 0→1 and 1→0. */
  const typeRefs = new Map<string, number>();
  let retainCount = 0;

  let socket: WebSocket | null = null;
  let connState: LiveBusState = 'closed';
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  const debug = (...args: unknown[]): void => {
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('[live-bus]', ...args);
    }
  };

  const setState = (next: LiveBusState): void => {
    if (connState === next) return;
    connState = next;
    for (const cb of stateSubs) {
      try {
        cb(next);
      } catch (err) {
        debug('state-sub threw', err);
      }
    }
  };

  const sendFrame = (frame: { type: 'subscribe' | 'unsubscribe'; events: string[] }): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (err) {
      debug(`${frame.type} send failed`, err);
    }
  };

  const addTypeRef = (eventType: string): void => {
    const next = (typeRefs.get(eventType) ?? 0) + 1;
    typeRefs.set(eventType, next);
    if (next === 1) sendFrame({ type: 'subscribe', events: [eventType] });
  };

  const releaseTypeRef = (eventType: string): void => {
    const next = (typeRefs.get(eventType) ?? 0) - 1;
    if (next > 0) {
      typeRefs.set(eventType, next);
      return;
    }
    typeRefs.delete(eventType);
    sendFrame({ type: 'unsubscribe', events: [eventType] });
  };

  const clearReconnect = (): void => {
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearIdle = (): void => {
    if (idleTimer != null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const teardownSocket = (): void => {
    if (!socket) return;
    try {
      socket.onopen = null;
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch (err) {
      debug('teardown failed', err);
    }
    socket = null;
  };

  const scheduleReconnect = (): void => {
    if (refCount() === 0) return;
    clearReconnect();
    // Джиттер: после рестарта API вкладки не должны возвращаться одновременной волной.
    const delay = jitteredBackoffMs(attempts);
    attempts++;
    debug(`reconnect in ${delay}ms (attempt ${attempts})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const open = (): void => {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
    teardownSocket();
    setState('connecting');
    let url: string;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      url = `${proto}://${window.location.host}/api/v1/ws/live`;
    } catch (err) {
      debug('cannot derive url', err);
      scheduleReconnect();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      debug('ws ctor threw', err);
      setState('closed');
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempts = 0;
      // A new connection starts with no subscriptions: re-declare every type
      // a mounted consumer still listens to (the server replays tails then).
      if (typeRefs.size > 0) sendFrame({ type: 'subscribe', events: [...typeRefs.keys()] });
      setState('open');
    };

    ws.onmessage = (ev) => {
      let frame: { type?: string } | null = null;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;
      // Subscription acknowledgements are protocol frames, not live events.
      if (frame.type === 'subscribed' || frame.type === 'unsubscribed') return;
      if (frame.type === 'ping') {
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch (err) {
          debug('pong send failed', err);
        }
        return;
      }
      const event = frame as LiveEvent;
      for (const cb of eventSubs) {
        try {
          cb(event);
        } catch (err) {
          debug('event-sub threw', err);
        }
      }
    };

    ws.onerror = () => {
      debug('ws error');
    };

    ws.onclose = () => {
      socket = null;
      setState('closed');
      scheduleReconnect();
    };
  };

  const ensureStarted = (): void => {
    if (started) return;
    if (typeof window === 'undefined') return;
    started = true;
    open();
  };

  const stop = (): void => {
    started = false;
    clearReconnect();
    teardownSocket();
    setState('closed');
    attempts = 0;
  };

  function refCount(): number {
    return eventSubs.size + stateSubs.size + retainCount;
  }

  const scheduleIdleClose = (): void => {
    clearIdle();
    if (refCount() > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (refCount() === 0) stop();
    }, IDLE_CLOSE_DELAY_MS);
  };

  const retain = (): void => {
    clearIdle();
    ensureStarted();
  };

  const release = (): void => {
    if (refCount() === 0) scheduleIdleClose();
  };

  const forceReconnect = (): void => {
    debug('forceReconnect requested');
    clearReconnect();
    attempts = 0;
    teardownSocket();
    setState('closed');
    if (refCount() > 0) {
      open();
    }
  };

  return {
    forceReconnect,
    retain: () => {
      retainCount++;
      retain();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retainCount--;
        release();
      };
    },
    subscribe(cb, eventType) {
      eventSubs.add(cb);
      if (eventType) addTypeRef(eventType);
      retain();
      return () => {
        eventSubs.delete(cb);
        if (eventType) releaseTypeRef(eventType);
        release();
      };
    },
    state() {
      return connState;
    },
    onStateChange(cb) {
      stateSubs.add(cb);
      retain();
      return () => {
        stateSubs.delete(cb);
        release();
      };
    },
  };
}

export function getLiveBus(): LiveBusHandle {
  if (typeof window === 'undefined') {
    return {
      subscribe: () => () => {},
      state: () => 'closed',
      onStateChange: () => () => {},
      retain: () => () => {},
      forceReconnect: () => {},
    };
  }
  if (!singleton) singleton = makeLiveBus();
  return singleton;
}
