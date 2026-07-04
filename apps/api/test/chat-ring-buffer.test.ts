import { describe, expect, it } from 'vitest';
import { ChatRingBuffer } from '../src/lib/chat-ring-buffer.js';
import type { LiveEvent } from '../src/plugins/live-bus.js';

type ChatEvent = Extract<LiveEvent, { type: 'chat.message' }>;

function chat(serverId: string, id: string, message = 'hi'): ChatEvent {
  return {
    type: 'chat.message',
    ts: '2026-04-23T11:30:20.485Z',
    data: {
      id,
      server_id: serverId,
      ts: '2026-04-23T11:30:20.485Z',
      channel: 'ChatAll',
      player_id: null,
      player_name: 'Alpha',
      steam_id64: '76561198012345678',
      eos_id: null,
      message,
    },
  };
}

const SERVER_A = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';
const SERVER_B = '019dbac8-ceb0-77ab-859b-bfa9a282ffff';

describe('ChatRingBuffer', () => {
  it('replays pushed messages in insertion order', () => {
    const buf = new ChatRingBuffer(10);
    buf.push(chat(SERVER_A, '1'));
    buf.push(chat(SERVER_A, '2'));
    buf.push(chat(SERVER_A, '3'));
    expect(buf.tail().map((e) => e.data.id)).toEqual(['1', '2', '3']);
  });

  it('keeps only the last N messages per server (ring eviction)', () => {
    const buf = new ChatRingBuffer(3);
    for (const id of ['1', '2', '3', '4', '5']) buf.push(chat(SERVER_A, id));
    const ids = buf.tailFor(SERVER_A).map((e) => e.data.id);
    expect(ids).toEqual(['3', '4', '5']);
  });

  it('isolates the buffer per server', () => {
    const buf = new ChatRingBuffer(2);
    buf.push(chat(SERVER_A, 'a1'));
    buf.push(chat(SERVER_B, 'b1'));
    buf.push(chat(SERVER_A, 'a2'));
    buf.push(chat(SERVER_B, 'b2'));
    buf.push(chat(SERVER_B, 'b3'));
    expect(buf.tailFor(SERVER_A).map((e) => e.data.id)).toEqual(['a1', 'a2']);
    expect(buf.tailFor(SERVER_B).map((e) => e.data.id)).toEqual(['b2', 'b3']);
  });

  it('tail() aggregates all servers so a global reconnect loses no tail', () => {
    const buf = new ChatRingBuffer(2);
    buf.push(chat(SERVER_A, 'a1'));
    buf.push(chat(SERVER_B, 'b1'));
    const ids = buf
      .tail()
      .map((e) => e.data.id)
      .sort();
    expect(ids).toEqual(['a1', 'b1']);
  });

  it('ignores non chat.message events', () => {
    const buf = new ChatRingBuffer(5);
    buf.push({
      type: 'bridge.connection',
      ts: '2026-04-23T11:30:20.485Z',
      data: { state: 'up', down_for_s: 0 },
    });
    expect(buf.tail()).toHaveLength(0);
  });

  it('returns an empty tail for an unseen server', () => {
    const buf = new ChatRingBuffer(5);
    buf.push(chat(SERVER_A, '1'));
    expect(buf.tailFor(SERVER_B)).toEqual([]);
  });

  it('drops empty per-server buckets once fully evicted is not required but capacity is bounded', () => {
    const buf = new ChatRingBuffer(1);
    for (let i = 0; i < 50; i++) buf.push(chat(SERVER_A, String(i)));
    expect(buf.tailFor(SERVER_A).map((e) => e.data.id)).toEqual(['49']);
  });
});
