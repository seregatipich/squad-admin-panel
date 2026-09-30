import { useEffect, useSyncExternalStore } from 'react';
import { getLiveBus, type LiveEvent } from './live-bus';

export function useLiveSubscription<T extends LiveEvent['type']>(
  type: T,
  handler: (event: Extract<LiveEvent, { type: T }>) => void,
): void {
  useEffect(() => {
    const bus = getLiveBus();
    return bus.subscribe((event) => {
      if (event.type === type) handler(event as Extract<LiveEvent, { type: T }>);
    });
  }, [type, handler]);
}

function subscribeToBusState(callback: () => void): () => void {
  return getLiveBus().onStateChange(callback);
}

function getBusState() {
  return getLiveBus().state();
}

/**
 * Current live-bus connection state. `subscribe` and the snapshot getters are
 * module-level so their identity is stable across renders: an inline subscribe
 * would make React unsubscribe and resubscribe on every render.
 */
export function useLiveBusState() {
  return useSyncExternalStore(subscribeToBusState, getBusState, () => 'closed' as const);
}
