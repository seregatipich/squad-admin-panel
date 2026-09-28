import type { LiveEvent } from '../plugins/live-bus.js';

/** Live event types that carry a `server_id` and are worth replaying to a new subscriber. */
export type ReplayableEventType = 'chat.message' | 'combat.event';

type ReplayableEvent = Extract<LiveEvent, { type: ReplayableEventType }>;

/**
 * Bounded per-server ring of the most recent live events of one type, so a
 * socket that subscribes to that type (on page load or after a reconnect) can
 * be sent the tail it missed (CHAT-1, COMBAT-6).
 *
 * Each server keeps at most `capacity` events. A `server.deleted` event drops
 * that server's bucket, so the map does not keep growing with servers that no
 * longer exist.
 *
 * @typeParam T - The event type this buffer retains.
 */
export class ServerRingBuffer<T extends ReplayableEventType> {
  private readonly byServer = new Map<string, ReplayableEvent[]>();

  /**
   * @param eventType - The only event type retained; every other type is ignored
   *   (except `server.deleted`, which evicts a server).
   * @param capacity - Maximum events kept per server.
   */
  constructor(
    private readonly eventType: T,
    private readonly capacity: number,
  ) {}

  /** Feed one live-bus event; call it from a `liveBus.subscribe` callback. */
  push(event: LiveEvent): void {
    if (event.type === 'server.deleted') {
      this.byServer.delete(event.data.server_id);
      return;
    }
    if (event.type !== this.eventType) return;
    // `T` is generic, so the type guard above cannot narrow `event` itself.
    const retained = event as ReplayableEvent;
    const key = retained.data.server_id;
    const bucket = this.byServer.get(key) ?? [];
    bucket.push(retained);
    if (bucket.length > this.capacity) bucket.splice(0, bucket.length - this.capacity);
    this.byServer.set(key, bucket);
  }

  /** Every retained event, grouped by server in first-seen server order; a fresh array. */
  tail(): Extract<LiveEvent, { type: T }>[] {
    const all: ReplayableEvent[] = [];
    for (const bucket of this.byServer.values()) all.push(...bucket);
    // Only events of type `T` are ever pushed into the buckets.
    return all as Extract<LiveEvent, { type: T }>[];
  }

  /** Number of servers currently holding a bucket. */
  serverCount(): number {
    return this.byServer.size;
  }
}
