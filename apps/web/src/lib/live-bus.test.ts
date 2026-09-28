import { describe, expect, it } from 'vitest';
import { announcesMatchBoundary, getLiveBus } from './live-bus';

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
