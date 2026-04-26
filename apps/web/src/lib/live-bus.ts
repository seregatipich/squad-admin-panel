export type LiveEvent =
  | {
      type: 'server.status';
      ts: string;
      data: { server_id: string; status: string; source: 'reconciler' | 'install' | 'delete' };
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
    };

export type LiveBusState = 'connecting' | 'open' | 'closed';
export type BridgeState = 'up' | 'down' | 'unknown';

export interface LiveBusHandle {
  subscribe(cb: (event: LiveEvent) => void): () => void;
  state(): LiveBusState;
  bridgeState(): BridgeState;
  onStateChange(cb: (state: LiveBusState) => void): () => void;
  onBridgeChange(cb: (state: BridgeState) => void): () => void;
}

const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const IDLE_CLOSE_DELAY_MS = 5_000;

interface LiveBusInternal extends LiveBusHandle {
  retain(): void;
  release(): void;
}

let singleton: LiveBusInternal | null = null;

function makeLiveBus(): LiveBusInternal {
  const eventSubs = new Set<(event: LiveEvent) => void>();
  const stateSubs = new Set<(state: LiveBusState) => void>();
  const bridgeSubs = new Set<(state: BridgeState) => void>();

  let socket: WebSocket | null = null;
  let connState: LiveBusState = 'closed';
  let bridge: BridgeState = 'unknown';
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

  const setBridge = (next: BridgeState): void => {
    if (bridge === next) return;
    bridge = next;
    for (const cb of bridgeSubs) {
      try {
        cb(next);
      } catch (err) {
        debug('bridge-sub threw', err);
      }
    }
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
    if (eventSubs.size === 0 && stateSubs.size === 0 && bridgeSubs.size === 0) return;
    clearReconnect();
    const delay = BACKOFF_STEPS_MS[Math.min(attempts, BACKOFF_STEPS_MS.length - 1)];
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
      if (frame.type === 'ping') {
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch (err) {
          debug('pong send failed', err);
        }
        return;
      }
      const event = frame as LiveEvent;
      if (event.type === 'bridge.connection') {
        setBridge(event.data.state);
      }
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
    setBridge('unknown');
    attempts = 0;
  };

  const refCount = (): number => eventSubs.size + stateSubs.size + bridgeSubs.size;

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

  return {
    retain,
    release,
    subscribe(cb) {
      eventSubs.add(cb);
      retain();
      return () => {
        eventSubs.delete(cb);
        release();
      };
    },
    state() {
      return connState;
    },
    bridgeState() {
      return bridge;
    },
    onStateChange(cb) {
      stateSubs.add(cb);
      retain();
      return () => {
        stateSubs.delete(cb);
        release();
      };
    },
    onBridgeChange(cb) {
      bridgeSubs.add(cb);
      retain();
      return () => {
        bridgeSubs.delete(cb);
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
      bridgeState: () => 'unknown',
      onStateChange: () => () => {},
      onBridgeChange: () => () => {},
    };
  }
  if (!singleton) singleton = makeLiveBus();
  return singleton;
}
