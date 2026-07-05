import type { EventEnvelope } from '@squad/shared-types';
import { describe, expect, it } from 'vitest';
import { type AlertRuleInput, type EvaluationContext, evaluate } from '../src/alerts/engine.js';

const SERVER_ID = '01903f7d-6a15-7c81-aa91-1e4fa9f9b7c5';

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    type: 'player.connected',
    server_id: SERVER_ID,
    ts: '2026-07-05T10:00:00.000Z',
    actor: { kind: 'system', id: null },
    correlation_id: null,
    payload: {},
    ...overrides,
  } as EventEnvelope;
}

function makeRule(overrides: Partial<AlertRuleInput>): AlertRuleInput {
  return {
    id: 'rule-1',
    name: 'Rule',
    type: 'server_crashed',
    config: {},
    channels: ['email'],
    enabled: true,
    ...overrides,
  };
}

describe('evaluate — server_crashed rule', () => {
  const rule = makeRule({ id: 'crash', name: 'Server crashed', type: 'server_crashed' });

  it('fires a critical alert on a server.crashed event', () => {
    const drafts = evaluate(makeEvent({ type: 'server.crashed' }), [rule]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.ruleId).toBe('crash');
    expect(drafts[0]?.severity).toBe('critical');
    expect(drafts[0]?.payload.eventType).toBe('server.crashed');
  });

  it('does not fire on an unrelated event', () => {
    expect(evaluate(makeEvent({ type: 'server.ready' }), [rule])).toHaveLength(0);
  });

  it('honours a severity override in config', () => {
    const overridden = makeRule({ type: 'server_crashed', config: { severity: 'warning' } });
    const drafts = evaluate(makeEvent({ type: 'server.crashed' }), [overridden]);
    expect(drafts[0]?.severity).toBe('warning');
  });

  it('skips disabled rules', () => {
    const disabled = makeRule({ type: 'server_crashed', enabled: false });
    expect(evaluate(makeEvent({ type: 'server.crashed' }), [disabled])).toHaveLength(0);
  });
});

describe('evaluate — unusual_activity rule', () => {
  const rule = makeRule({
    id: 'flood',
    name: 'Connect flood',
    type: 'unusual_activity',
    config: { windowMinutes: 5, connectThreshold: 10 },
  });

  it('fires when observed connects reach the threshold (boundary)', () => {
    const context: EvaluationContext = { recentConnectCount: 10 };
    const drafts = evaluate(makeEvent({ type: 'player.connected' }), [rule], context);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.payload.connectCount).toBe(10);
    expect(drafts[0]?.severity).toBe('warning');
  });

  it('does not fire one below the threshold (boundary)', () => {
    const context: EvaluationContext = { recentConnectCount: 9 };
    expect(evaluate(makeEvent({ type: 'player.connected' }), [rule], context)).toHaveLength(0);
  });

  it('treats missing count as zero', () => {
    expect(evaluate(makeEvent({ type: 'player.connected' }), [rule], {})).toHaveLength(0);
  });

  it('ignores non-connect events', () => {
    const context: EvaluationContext = { recentConnectCount: 99 };
    expect(evaluate(makeEvent({ type: 'server.ready' }), [rule], context)).toHaveLength(0);
  });

  it('ignores a rule with a non-positive threshold', () => {
    const zero = makeRule({
      type: 'unusual_activity',
      config: { windowMinutes: 5, connectThreshold: 0 },
    });
    const context: EvaluationContext = { recentConnectCount: 100 };
    expect(evaluate(makeEvent({ type: 'player.connected' }), [zero], context)).toHaveLength(0);
  });
});

describe('evaluate — admin_login_new_ip rule', () => {
  const rule = makeRule({
    id: 'admin-ip',
    name: 'Admin new IP',
    type: 'admin_login_new_ip',
    config: {},
  });

  it('does not fire when the admin logs in from a known IP', () => {
    const context: EvaluationContext = {
      admin: { isPanelAdmin: true, knownIps: ['203.0.113.5'] },
    };
    const event = makeEvent({ type: 'player.connected', payload: { ip: '203.0.113.5' } });
    expect(evaluate(event, [rule], context)).toHaveLength(0);
  });

  it('fires when the admin logs in from a new IP', () => {
    const context: EvaluationContext = {
      admin: { isPanelAdmin: true, knownIps: ['203.0.113.5'] },
    };
    const event = makeEvent({
      type: 'player.connected',
      actor: { kind: 'user', id: 'player-uuid' },
      payload: { ip: '198.51.100.9' },
    });
    const drafts = evaluate(event, [rule], context);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.payload.ip).toBe('198.51.100.9');
    expect(drafts[0]?.payload.actorId).toBe('player-uuid');
  });

  it('does not fire for a non-admin player', () => {
    const context: EvaluationContext = {
      admin: { isPanelAdmin: false, knownIps: [] },
    };
    const event = makeEvent({ type: 'player.connected', payload: { ip: '198.51.100.9' } });
    expect(evaluate(event, [rule], context)).toHaveLength(0);
  });

  it('does not fire when there is no admin context', () => {
    const event = makeEvent({ type: 'player.connected', payload: { ip: '198.51.100.9' } });
    expect(evaluate(event, [rule], {})).toHaveLength(0);
  });

  it('does not fire when the connect event carries no IP', () => {
    const context: EvaluationContext = {
      admin: { isPanelAdmin: true, knownIps: [] },
    };
    const event = makeEvent({ type: 'player.connected', payload: { ip: null } });
    expect(evaluate(event, [rule], context)).toHaveLength(0);
  });

  it('ignores non-connect events', () => {
    const context: EvaluationContext = {
      admin: { isPanelAdmin: true, knownIps: [] },
    };
    expect(evaluate(makeEvent({ type: 'server.ready' }), [rule], context)).toHaveLength(0);
  });
});

describe('evaluate — custom rule', () => {
  it('fires when the event kind matches and no threshold is set', () => {
    const rule = makeRule({
      id: 'custom-1',
      type: 'custom',
      config: { eventKind: 'performance.degraded' },
    });
    const drafts = evaluate(makeEvent({ type: 'performance.degraded' }), [rule]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.severity).toBe('info');
    expect(drafts[0]?.payload.matchedKind).toBe('performance.degraded');
  });

  it('respects a configured threshold over customCounts', () => {
    const rule = makeRule({
      id: 'custom-2',
      type: 'custom',
      config: { eventKind: 'rcon.disconnected', threshold: 3, severity: 'critical' },
    });
    const event = makeEvent({ type: 'rcon.disconnected' });
    expect(evaluate(event, [rule], { customCounts: { 'custom-2': 2 } })).toHaveLength(0);
    const fired = evaluate(event, [rule], { customCounts: { 'custom-2': 3 } });
    expect(fired).toHaveLength(1);
    expect(fired[0]?.severity).toBe('critical');
  });

  it('does not fire on a different event kind', () => {
    const rule = makeRule({ type: 'custom', config: { eventKind: 'server.stopped' } });
    expect(evaluate(makeEvent({ type: 'server.ready' }), [rule])).toHaveLength(0);
  });

  it('ignores a custom rule with an empty eventKind', () => {
    const rule = makeRule({ type: 'custom', config: { eventKind: '' } });
    expect(evaluate(makeEvent({ type: 'server.ready' }), [rule])).toHaveLength(0);
  });
});

describe('evaluate — multiple rules', () => {
  it('returns one draft per firing rule', () => {
    const crash = makeRule({ id: 'a', type: 'server_crashed' });
    const custom = makeRule({ id: 'b', type: 'custom', config: { eventKind: 'server.crashed' } });
    const drafts = evaluate(makeEvent({ type: 'server.crashed' }), [crash, custom]);
    expect(drafts.map((draft) => draft.ruleId).sort()).toEqual(['a', 'b']);
  });

  it('returns an empty array when no rules are supplied', () => {
    expect(evaluate(makeEvent({ type: 'server.crashed' }), [])).toEqual([]);
  });
});
