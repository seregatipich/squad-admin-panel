import { describe, expect, it } from 'vitest';
import {
  type AutomationRuleInput,
  type AutomationTriggerInput,
  evaluate,
} from '../src/rules/engine.js';

const SERVER_A = '00000000-0000-0000-0000-0000000000aa';
const SERVER_B = '00000000-0000-0000-0000-0000000000bb';

function rule(overrides: Partial<AutomationRuleInput>): AutomationRuleInput {
  return {
    id: 'rule-1',
    serverId: null,
    name: 'test rule',
    conditionType: 'chat_keyword',
    condition: { keyword: 'hello' },
    actionType: 'warn',
    action: { message: 'hi' },
    enabled: true,
    ...overrides,
  };
}

function trigger(overrides: Partial<AutomationTriggerInput>): AutomationTriggerInput {
  return { serverId: SERVER_A, now: new Date('2026-07-24T12:00:00.000Z'), ...overrides };
}

describe('evaluate — chat_keyword', () => {
  it('matches when the keyword is contained (case-insensitive by default)', () => {
    const matches = evaluate(trigger({ chatMessage: 'Well HELLO there' }), [
      rule({ conditionType: 'chat_keyword', condition: { keyword: 'hello' } }),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matched).toMatchObject({ keyword: 'hello', match: 'contains' });
    expect(matches[0]?.actionType).toBe('warn');
  });

  it('does not match when the keyword is absent', () => {
    const matches = evaluate(trigger({ chatMessage: 'goodbye' }), [
      rule({ conditionType: 'chat_keyword', condition: { keyword: 'hello' } }),
    ]);
    expect(matches).toHaveLength(0);
  });

  it('respects caseSensitive matching', () => {
    const cfg = { keyword: 'Hello', caseSensitive: true };
    expect(evaluate(trigger({ chatMessage: 'hello' }), [rule({ condition: cfg })])).toHaveLength(0);
    expect(evaluate(trigger({ chatMessage: 'Hello' }), [rule({ condition: cfg })])).toHaveLength(1);
  });

  it('word match requires a whole-word hit', () => {
    const cfg = { keyword: 'ban', match: 'word' };
    expect(
      evaluate(trigger({ chatMessage: 'please ban him' }), [rule({ condition: cfg })]),
    ).toHaveLength(1);
    expect(
      evaluate(trigger({ chatMessage: 'urban legend' }), [rule({ condition: cfg })]),
    ).toHaveLength(0);
  });

  it('never matches a chat rule when the trigger carries no chat message', () => {
    const matches = evaluate(trigger({ playerCount: 50 }), [
      rule({ conditionType: 'chat_keyword' }),
    ]);
    expect(matches).toHaveLength(0);
  });
});

describe('evaluate — player_count', () => {
  const pcRule = (condition: unknown) =>
    rule({
      conditionType: 'player_count',
      condition,
      actionType: 'notify_admin',
      action: { message: 'seeding' },
    });

  it('matches when count is over the gte threshold', () => {
    const matches = evaluate(trigger({ playerCount: 80 }), [
      pcRule({ operator: 'gte', threshold: 60 }),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matched).toMatchObject({ observed: 80, threshold: 60, operator: 'gte' });
  });

  it('does not match when count is under the threshold', () => {
    expect(
      evaluate(trigger({ playerCount: 40 }), [pcRule({ operator: 'gte', threshold: 60 })]),
    ).toHaveLength(0);
  });

  it('supports lte / eq operators at the boundary', () => {
    expect(
      evaluate(trigger({ playerCount: 0 }), [pcRule({ operator: 'lte', threshold: 0 })]),
    ).toHaveLength(1);
    expect(
      evaluate(trigger({ playerCount: 1 }), [pcRule({ operator: 'eq', threshold: 1 })]),
    ).toHaveLength(1);
    expect(
      evaluate(trigger({ playerCount: 2 }), [pcRule({ operator: 'eq', threshold: 1 })]),
    ).toHaveLength(0);
  });

  it('never matches when the trigger carries no player count', () => {
    expect(evaluate(trigger({ chatMessage: 'x' }), [pcRule({ threshold: 1 })])).toHaveLength(0);
  });
});

describe('evaluate — time_of_day', () => {
  const todRule = (condition: unknown) =>
    rule({
      conditionType: 'time_of_day',
      condition,
      actionType: 'notify_admin',
      action: { message: 'night' },
    });

  it('matches inside a same-day UTC window', () => {
    // 12:00 UTC is 720 minutes.
    const matches = evaluate(trigger({ now: new Date('2026-07-24T12:00:00Z') }), [
      todRule({ startMinute: 600, endMinute: 800, timezone: 'UTC' }),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matched).toMatchObject({ minute: 720 });
  });

  it('does not match outside the window', () => {
    expect(
      evaluate(trigger({ now: new Date('2026-07-24T12:00:00Z') }), [
        todRule({ startMinute: 0, endMinute: 300, timezone: 'UTC' }),
      ]),
    ).toHaveLength(0);
  });

  it('matches an overnight window that wraps past midnight', () => {
    // 01:00 UTC = 60 minutes, window 23:00–02:00 (1380 → 120).
    expect(
      evaluate(trigger({ now: new Date('2026-07-24T01:00:00Z') }), [
        todRule({ startMinute: 1380, endMinute: 120, timezone: 'UTC' }),
      ]),
    ).toHaveLength(1);
  });

  it('restricts to configured weekdays', () => {
    // 2026-07-24 is a Friday (weekday 5).
    expect(
      evaluate(trigger({ now: new Date('2026-07-24T12:00:00Z') }), [
        todRule({ startMinute: 0, endMinute: 1439, timezone: 'UTC', weekdays: [5] }),
      ]),
    ).toHaveLength(1);
    expect(
      evaluate(trigger({ now: new Date('2026-07-24T12:00:00Z') }), [
        todRule({ startMinute: 0, endMinute: 1439, timezone: 'UTC', weekdays: [0] }),
      ]),
    ).toHaveLength(0);
  });

  it('honours the configured timezone', () => {
    // 23:00 UTC is 08:00 (480) in Asia/Tokyo (+9).
    expect(
      evaluate(trigger({ now: new Date('2026-07-24T23:00:00Z') }), [
        todRule({ startMinute: 470, endMinute: 490, timezone: 'Asia/Tokyo' }),
      ]),
    ).toHaveLength(1);
  });
});

describe('evaluate — player_flag', () => {
  const flagRule = (condition: unknown) =>
    rule({
      conditionType: 'player_flag',
      condition,
      actionType: 'warn',
      action: { message: 'watched' },
    });

  it('matches when a required flag is present', () => {
    const matches = evaluate(trigger({ playerFlags: ['vip', 'watched'] }), [
      flagRule({ flag: 'watched', present: true }),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matched).toMatchObject({ flag: 'watched', has: true });
  });

  it('does not match when the required flag is absent', () => {
    expect(
      evaluate(trigger({ playerFlags: ['vip'] }), [flagRule({ flag: 'watched', present: true })]),
    ).toHaveLength(0);
  });

  it('matches on absence when present=false', () => {
    expect(
      evaluate(trigger({ playerFlags: ['vip'] }), [flagRule({ flag: 'watched', present: false })]),
    ).toHaveLength(1);
  });

  it('never matches when the trigger carries no flags', () => {
    expect(evaluate(trigger({ chatMessage: 'x' }), [flagRule({ flag: 'watched' })])).toHaveLength(
      0,
    );
  });
});

describe('evaluate — scoping & guards', () => {
  it('skips disabled rules', () => {
    expect(evaluate(trigger({ chatMessage: 'hello' }), [rule({ enabled: false })])).toHaveLength(0);
  });

  it('a server-scoped rule ignores other servers', () => {
    expect(
      evaluate(trigger({ serverId: SERVER_B, chatMessage: 'hello' }), [
        rule({ serverId: SERVER_A }),
      ]),
    ).toHaveLength(0);
    expect(
      evaluate(trigger({ serverId: SERVER_A, chatMessage: 'hello' }), [
        rule({ serverId: SERVER_A }),
      ]),
    ).toHaveLength(1);
  });

  it('a global rule matches every server', () => {
    expect(
      evaluate(trigger({ serverId: SERVER_B, chatMessage: 'hello' }), [rule({ serverId: null })]),
    ).toHaveLength(1);
  });

  it('drops a rule whose action config is invalid', () => {
    expect(
      evaluate(trigger({ chatMessage: 'hello' }), [
        rule({ actionType: 'rcon_command', action: { command: 'NotACommand' } }),
      ]),
    ).toHaveLength(0);
  });

  it('carries the player ref onto the match', () => {
    const player = { playerId: 'p1', steamId64: '76561190000000001', eosId: null, name: 'Alice' };
    const matches = evaluate(trigger({ chatMessage: 'hello', player }), [rule({})]);
    expect(matches[0]?.player).toEqual(player);
  });
});
