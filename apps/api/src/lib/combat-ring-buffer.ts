import type { LiveEvent } from '../plugins/live-bus.js';

type CombatEvent = Extract<LiveEvent, { type: 'combat.event' }>;

/**
 * Bounded per-server ring of the most recent combat events so a WebSocket
 * reconnect can replay the tail it missed (COMBAT-6). Live combat events fan
 * out through the live bus; this buffer only retains `combat.event` events
 * and caps each server at `capacity` entries.
 */
export class CombatRingBuffer {
  private readonly byServer = new Map<string, CombatEvent[]>();

  constructor(private readonly capacity: number) {}

  push(event: LiveEvent): void {
    if (event.type !== 'combat.event') return;
    const key = event.data.server_id;
    const bucket = this.byServer.get(key) ?? [];
    bucket.push(event);
    if (bucket.length > this.capacity) bucket.splice(0, bucket.length - this.capacity);
    this.byServer.set(key, bucket);
  }

  tailFor(serverId: string): CombatEvent[] {
    return [...(this.byServer.get(serverId) ?? [])];
  }

  tail(): CombatEvent[] {
    const all: CombatEvent[] = [];
    for (const bucket of this.byServer.values()) all.push(...bucket);
    return all;
  }
}
