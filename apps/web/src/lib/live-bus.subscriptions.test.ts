// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #69 (finding #1305): the API pushes opt-in event types (chat, combat, roster
 * snapshots, …) only to sockets that subscribed to them, so the browser client
 * must declare what its mounted consumers listen to — on open, on the first
 * consumer of a type, after every reconnect — and withdraw it when the last
 * consumer unmounts.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<{ type: string; events?: string[] }> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as { type: string; events?: string[] });
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

async function freshBus() {
  vi.resetModules();
  const mod = await import('./live-bus');
  return mod.getLiveBus();
}

const subscriptionFrames = (socket: FakeSocket) =>
  socket.sent.filter((f) => f.type === 'subscribe' || f.type === 'unsubscribe');

describe('live bus event subscriptions (browser)', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('declares the types of consumers mounted before the socket opens, in one frame', async () => {
    const bus = await freshBus();
    bus.subscribe(() => {}, 'chat.message');
    bus.subscribe(() => {}, 'combat.event');
    const socket = FakeSocket.instances[0] as FakeSocket;
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(subscriptionFrames(socket)).toEqual([
      { type: 'subscribe', events: ['chat.message', 'combat.event'] },
    ]);
  });

  it('subscribes on the first consumer of a type and unsubscribes after the last one leaves', async () => {
    const bus = await freshBus();
    const keepAlive = bus.subscribe(() => {});
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();

    const first = bus.subscribe(() => {}, 'chat.message');
    const second = bus.subscribe(() => {}, 'chat.message');
    first();
    expect(subscriptionFrames(socket)).toEqual([{ type: 'subscribe', events: ['chat.message'] }]);
    second();
    expect(subscriptionFrames(socket)).toEqual([
      { type: 'subscribe', events: ['chat.message'] },
      { type: 'unsubscribe', events: ['chat.message'] },
    ]);
    keepAlive();
  });

  it('re-declares live subscriptions on a reconnected socket', async () => {
    const bus = await freshBus();
    bus.subscribe(() => {}, 'rcon.roster');
    const first = FakeSocket.instances[0] as FakeSocket;
    first.open();

    bus.forceReconnect();
    const second = FakeSocket.instances[1] as FakeSocket;
    second.open();
    expect(subscriptionFrames(second)).toEqual([{ type: 'subscribe', events: ['rcon.roster'] }]);
  });

  it('does not hand subscription acknowledgements to event consumers', async () => {
    const bus = await freshBus();
    const received: string[] = [];
    bus.subscribe((event) => received.push(event.type), 'chat.message');
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();

    socket.deliver({ type: 'subscribed', events: ['chat.message'] });
    socket.deliver({ type: 'bridge.connection', ts: 'now', data: { state: 'up', down_for_s: 0 } });
    expect(received).toEqual(['bridge.connection']);
  });
});

describe('live bus reconnect after an expired session (browser)', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Fails every socket the bus opens, `rounds` times over, letting each backoff elapse. */
  const failSockets = async (rounds: number): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      FakeSocket.instances.at(-1)?.onclose?.();
      await vi.advanceTimersByTimeAsync(30_000);
    }
  };

  it('stops reconnecting and leaves for the login page once /me answers 401', async () => {
    const fetchMock = vi.fn(async () => ({ status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const bus = await freshBus();
    bus.subscribe(() => {});

    await failSockets(3);
    const socketsBefore = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/me', expect.anything());
    expect(window.location.href).toContain('/login');
    expect(FakeSocket.instances.length).toBe(socketsBefore);
  });

  it('keeps reconnecting while /me still answers 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200 })),
    );
    const bus = await freshBus();
    bus.subscribe(() => {});

    await failSockets(3);
    const before = FakeSocket.instances.length;
    await failSockets(2);

    expect(FakeSocket.instances.length).toBeGreaterThan(before);
  });
});
