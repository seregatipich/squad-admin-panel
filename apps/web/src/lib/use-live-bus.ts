import { useEffect, useSyncExternalStore } from 'react';
import { getLiveBus, type LiveEvent } from './live-bus';

export function useLiveSubscription<T extends LiveEvent['type']>(
  type: T,
  handler: (event: Extract<LiveEvent, { type: T }>) => void,
): void {
  useEffect(() => {
    const bus = getLiveBus();
    // Passing `type` declares interest, so opt-in types (chat, combat, …) are
    // pushed to this tab only while a consumer is mounted.
    return bus.subscribe((event) => {
      if (event.type === type) handler(event as Extract<LiveEvent, { type: T }>);
    }, type);
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
