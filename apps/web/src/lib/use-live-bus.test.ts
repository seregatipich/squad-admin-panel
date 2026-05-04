import { describe, expect, it } from 'vitest';
import { useBridgeState, useLiveBusState, useLiveSubscription } from './use-live-bus';

describe('use-live-bus exports', () => {
  it('useLiveSubscription is a function', () => {
    expect(typeof useLiveSubscription).toBe('function');
  });

  it('useLiveBusState is a function', () => {
    expect(typeof useLiveBusState).toBe('function');
  });

  it('useBridgeState is a function', () => {
    expect(typeof useBridgeState).toBe('function');
  });
});
