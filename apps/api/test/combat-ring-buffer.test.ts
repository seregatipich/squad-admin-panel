import { describe, expect, it } from 'vitest';
import { CombatRingBuffer } from '../src/lib/combat-ring-buffer.js';
import type { LiveEvent } from '../src/plugins/live-bus.js';

type CombatEvent = Extract<LiveEvent, { type: 'combat.event' }>;

function combat(
  serverId: string,
  occurredAt: string,
  kind: CombatEvent['data']['kind'] = 'combat_death',
): CombatEvent {
  return {
    type: 'combat.event',
    ts: occurredAt,
    data: {
      server_id: serverId,
      match_id: null,
      kind,
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

const SERVER_A = '019dbac8-ceb0-77ab-859b-bfa9a282ee2c';
const SERVER_B = '019dbac8-ceb0-77ab-859b-bfa9a282ffff';

describe('CombatRingBuffer', () => {
  it('replays pushed events in insertion order', () => {
    const buf = new CombatRingBuffer(10);
    buf.push(combat(SERVER_A, '2026-07-09T10:00:00.000Z'));
    buf.push(combat(SERVER_A, '2026-07-09T10:00:01.000Z'));
    buf.push(combat(SERVER_A, '2026-07-09T10:00:02.000Z'));
    expect(buf.tail().map((e) => e.data.occurred_at)).toEqual([
      '2026-07-09T10:00:00.000Z',
      '2026-07-09T10:00:01.000Z',
      '2026-07-09T10:00:02.000Z',
    ]);
  });

  it('keeps only the last N events per server (ring eviction)', () => {
    const buf = new CombatRingBuffer(3);
    for (let i = 0; i < 5; i++) buf.push(combat(SERVER_A, `2026-07-09T10:00:0${i}.000Z`));
    const ts = buf.tailFor(SERVER_A).map((e) => e.data.occurred_at);
    expect(ts).toEqual([
      '2026-07-09T10:00:02.000Z',
      '2026-07-09T10:00:03.000Z',
      '2026-07-09T10:00:04.000Z',
    ]);
  });

  it('isolates the buffer per server', () => {
    const buf = new CombatRingBuffer(2);
    buf.push(combat(SERVER_A, '2026-07-09T10:00:00.000Z'));
    buf.push(combat(SERVER_B, '2026-07-09T10:00:01.000Z'));
    buf.push(combat(SERVER_A, '2026-07-09T10:00:02.000Z'));
    expect(buf.tailFor(SERVER_A)).toHaveLength(2);
    expect(buf.tailFor(SERVER_B)).toHaveLength(1);
  });

  it('tail() aggregates all servers so a global reconnect loses no tail', () => {
    const buf = new CombatRingBuffer(2);
    buf.push(combat(SERVER_A, '2026-07-09T10:00:00.000Z'));
    buf.push(combat(SERVER_B, '2026-07-09T10:00:01.000Z'));
    expect(buf.tail()).toHaveLength(2);
  });

  it('ignores non combat.event events', () => {
    const buf = new CombatRingBuffer(5);
    buf.push({
      type: 'bridge.connection',
      ts: '2026-07-09T10:00:00.000Z',
      data: { state: 'up', down_for_s: 0 },
    });
    expect(buf.tail()).toHaveLength(0);
  });

  it('returns an empty tail for an unseen server', () => {
    const buf = new CombatRingBuffer(5);
    buf.push(combat(SERVER_A, '2026-07-09T10:00:00.000Z'));
    expect(buf.tailFor(SERVER_B)).toEqual([]);
  });
});
