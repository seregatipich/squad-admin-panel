import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announcesMatchBoundary, getLiveBus } from './live-bus';

describe('getLiveBus (SSR / no-window environment)', () => {
  it('returns a handle with state() === closed', () => {
    const bus = getLiveBus();
    expect(bus.state()).toBe('closed');
  });

  it('subscribe returns a callable unsubscribe function', () => {
    const bus = getLiveBus();
    const unsub = bus.subscribe(() => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('onStateChange returns a callable unsubscribe function', () => {
    const bus = getLiveBus();
    const unsub = bus.onStateChange(() => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('retain returns a callable release function', () => {
    const bus = getLiveBus();
    const release = bus.retain();
    expect(typeof release).toBe('function');
    expect(() => release()).not.toThrow();
  });

  it('multiple calls each return a valid handle', () => {
    const a = getLiveBus();
    const b = getLiveBus();
    expect(a.state()).toBe('closed');
    expect(b.state()).toBe('closed');
  });
});

describe('announcesMatchBoundary', () => {
  it('is true when the batch carries a match start or end', () => {
    expect(announcesMatchBoundary({ server_id: 'srv-1', kinds: ['match.started'] })).toBe(true);
    expect(
      announcesMatchBoundary({ server_id: 'srv-1', kinds: ['combat_death', 'match.ended'] }),
    ).toBe(true);
  });

  it('is false for batches without a match boundary', () => {
    expect(announcesMatchBoundary({ server_id: 'srv-1', kinds: ['player.joined'] })).toBe(false);
    expect(announcesMatchBoundary({ server_id: 'srv-1', kinds: [] })).toBe(false);
  });

  it('checks the server when one is given', () => {
    const batch = { server_id: 'srv-1', kinds: ['match.started'] };
    expect(announcesMatchBoundary(batch, 'srv-1')).toBe(true);
    expect(announcesMatchBoundary(batch, 'srv-2')).toBe(false);
    expect(announcesMatchBoundary({ server_id: null, kinds: ['match.started'] }, 'srv-1')).toBe(
      false,
    );
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

describe('getLiveBus in a browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeWebSocket.instances = [];
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'panel.test' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function freshBus() {
    const { getLiveBus } = await import('./live-bus');
    return getLiveBus();
  }

  it('keeps the socket open past the idle delay while it is retained', async () => {
    const bus = await freshBus();
    const release = bus.retain();
    const unsubscribe = bus.subscribe(() => {});
    unsubscribe();

    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances[0].readyState).not.toBe(3);
    expect(bus.state()).not.toBe('closed');
    release();
  });

  it('reconnects after a drop when only a retain holder is left', async () => {
    const bus = await freshBus();
    const release = bus.retain();
    FakeWebSocket.instances[0].onclose?.();

    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    release();
  });

  it('counts a double release once', async () => {
    const bus = await freshBus();
    const first = bus.retain();
    const second = bus.retain();
    first();
    first();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances[0].readyState).not.toBe(3);
    second();
  });

  it('closes the socket after the last holder releases it', async () => {
    const bus = await freshBus();
    bus.retain()();
    vi.advanceTimersByTime(5_000);
    expect(FakeWebSocket.instances[0].readyState).toBe(3);
  });

  it('spreads reconnects with jitter within the backoff step', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const bus = await freshBus();
    const release = bus.retain();
    FakeWebSocket.instances[0].onclose?.();

    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    release();
  });
});
