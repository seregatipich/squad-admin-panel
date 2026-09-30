import { describe, expect, it } from 'vitest';
import { ServerRingBuffer } from '../src/lib/server-ring-buffer.js';
import type { LiveEvent } from '../src/plugins/live-bus.js';

type ChatEvent = Extract<LiveEvent, { type: 'chat.message' }>;
type CombatEvent = Extract<LiveEvent, { type: 'combat.event' }>;

function chat(serverId: string, id: string): ChatEvent {
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
      source: 'log',
      message: 'hi',
    },
  };
}

function combat(serverId: string, occurredAt: string): CombatEvent {
  return {
    type: 'combat.event',
    ts: occurredAt,
    data: {
      server_id: serverId,
      match_id: null,
      kind: 'combat_death',
      attacker_player_id: 'attacker-1',
      victim_player_id: 'victim-1',
      weapon: 'BP_AK74',
      damage: 100,
      is_teamkill: false,
      is_suicide: false,
      occurred_at: occurredAt,
    },
  };
}

function serverDeleted(serverId: string): LiveEvent {
  return {
    type: 'server.deleted',
    ts: '2026-04-23T11:31:00.000Z',
    data: { server_id: serverId, deleted_at: '2026-04-23T11:31:00.000Z', by: null },
  };
}

const SERVER_A = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';
const SERVER_B = '019dbac8-ceb0-77ab-859b-bfa9a282ffff';

const ids = (events: ChatEvent[]) => events.map((e) => e.data.id);

describe('ServerRingBuffer', () => {
  it('replays pushed events in insertion order', () => {
    const buf = new ServerRingBuffer('chat.message', 10);
    for (const id of ['1', '2', '3']) buf.push(chat(SERVER_A, id));
    expect(ids(buf.tail())).toEqual(['1', '2', '3']);
  });

  it('keeps only the last N events per server, independently for each server', () => {
    const buf = new ServerRingBuffer('chat.message', 2);
    for (const id of ['a1', 'a2', 'a3']) buf.push(chat(SERVER_A, id));
    buf.push(chat(SERVER_B, 'b1'));
    expect(ids(buf.tail()).sort()).toEqual(['a2', 'a3', 'b1']);
  });

  it('only retains its own event type', () => {
    const chatBuf = new ServerRingBuffer('chat.message', 5);
    const combatBuf = new ServerRingBuffer('combat.event', 5);
    for (const event of [chat(SERVER_A, 'c1'), combat(SERVER_A, '2026-07-09T10:00:00.000Z')]) {
      chatBuf.push(event);
      combatBuf.push(event);
    }
    chatBuf.push({
      type: 'bridge.connection',
      ts: '2026-04-23T11:30:20.485Z',
      data: { state: 'up', down_for_s: 0 },
    });
    expect(ids(chatBuf.tail())).toEqual(['c1']);
    expect(combatBuf.tail().map((e) => e.data.occurred_at)).toEqual(['2026-07-09T10:00:00.000Z']);
  });

  it('drops a server’s bucket when that server is deleted', () => {
    const buf = new ServerRingBuffer('chat.message', 5);
    buf.push(chat(SERVER_A, 'a1'));
    buf.push(chat(SERVER_B, 'b1'));
    buf.push(serverDeleted(SERVER_B));
    expect(ids(buf.tail())).toEqual(['a1']);
    expect(buf.serverCount()).toBe(1);
  });

  it('returns a copy, so callers cannot mutate the stored tail', () => {
    const buf = new ServerRingBuffer('chat.message', 5);
    buf.push(chat(SERVER_A, '1'));
    buf.tail().pop();
    expect(ids(buf.tail())).toEqual(['1']);
  });
});
