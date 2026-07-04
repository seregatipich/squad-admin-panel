import type { LiveEvent } from '../plugins/live-bus.js';

type ChatMessageEvent = Extract<LiveEvent, { type: 'chat.message' }>;

/**
 * Bounded per-server ring of the most recent chat messages so a WebSocket
 * reconnect can replay the tail it missed (CHAT-1). Live chat fans out through
 * the live bus; this buffer only retains `chat.message` events and caps each
 * server at `capacity` entries.
 */
export class ChatRingBuffer {
  private readonly byServer = new Map<string, ChatMessageEvent[]>();

  constructor(private readonly capacity: number) {}

  push(event: LiveEvent): void {
    if (event.type !== 'chat.message') return;
    const key = event.data.server_id;
    const bucket = this.byServer.get(key) ?? [];
    bucket.push(event);
    if (bucket.length > this.capacity) bucket.splice(0, bucket.length - this.capacity);
    this.byServer.set(key, bucket);
  }

  tailFor(serverId: string): ChatMessageEvent[] {
    return [...(this.byServer.get(serverId) ?? [])];
  }

  tail(): ChatMessageEvent[] {
    const all: ChatMessageEvent[] = [];
    for (const bucket of this.byServer.values()) all.push(...bucket);
    return all;
  }
}
