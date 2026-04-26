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

export function useLiveBusState() {
  const bus = typeof window !== 'undefined' ? getLiveBus() : null;
  return useSyncExternalStore(
    (cb) => (bus ? bus.onStateChange(cb) : () => {}),
    () => (bus ? bus.state() : 'closed'),
    () => 'closed' as const,
  );
}

export function useBridgeState() {
  const bus = typeof window !== 'undefined' ? getLiveBus() : null;
  return useSyncExternalStore(
    (cb) => (bus ? bus.onBridgeChange(cb) : () => {}),
    () => (bus ? bus.bridgeState() : 'unknown'),
    () => 'unknown' as const,
  );
}
