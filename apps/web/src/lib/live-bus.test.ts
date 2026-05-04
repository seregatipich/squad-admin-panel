import { describe, expect, it } from 'vitest';
import { getLiveBus } from './live-bus';

describe('getLiveBus (SSR / no-window environment)', () => {
  it('returns a handle with state() === closed', () => {
    const bus = getLiveBus();
    expect(bus.state()).toBe('closed');
  });

  it('returns a handle with bridgeState() === unknown', () => {
    const bus = getLiveBus();
    expect(bus.bridgeState()).toBe('unknown');
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

  it('onBridgeChange returns a callable unsubscribe function', () => {
    const bus = getLiveBus();
    const unsub = bus.onBridgeChange(() => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('retain returns a callable release function', () => {
    const bus = getLiveBus();
    const release = bus.retain();
    expect(typeof release).toBe('function');
    expect(() => release()).not.toThrow();
  });

  it('forceReconnect does not throw', () => {
    const bus = getLiveBus();
    expect(() => bus.forceReconnect()).not.toThrow();
  });

  it('multiple calls each return a valid handle', () => {
    const a = getLiveBus();
    const b = getLiveBus();
    expect(a.state()).toBe('closed');
    expect(b.state()).toBe('closed');
  });
});
