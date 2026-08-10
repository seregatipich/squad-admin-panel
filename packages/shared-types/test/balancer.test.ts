import { describe, expect, it } from 'vitest';
import {
  BALANCER_DECISIONS,
  BALANCER_PROPOSAL_MODES,
  BALANCER_PROPOSAL_STATES,
  BALANCER_PROPOSAL_STATUSES,
  BALANCER_SCHEMA_VERSION,
  BALANCER_SUBJECT_TYPES,
  BALANCER_TRIGGER_KINDS,
  BALANCER_VETO_REASON_KINDS,
  DEFAULT_BALANCER_THRESHOLDS,
  evaluateBalancerSignals,
  readBalancerSignals,
} from '../src/balancer.js';
import { RCON_OPERATOR_COMMANDS } from '../src/rcon-commands.js';

const THRESHOLDS = {
  winStreakThreshold: 3,
  ticketDiffThreshold: 150,
  oneSidedRoundsThreshold: 2,
};

describe('balancer enums', () => {
  it('declares the proposal granularity modes the panel stores', () => {
    expect(BALANCER_PROPOSAL_MODES).toEqual(['squad', 'player']);
  });

  it('declares the three deterministic diff states', () => {
    expect(BALANCER_PROPOSAL_STATES).toEqual(['on_target', 'no_change', 'should_move']);
  });

  it('declares the subject types a proposal entry can address', () => {
    expect(BALANCER_SUBJECT_TYPES).toEqual(['squad', 'group', 'player']);
  });

  it('declares the proposal review lifecycle statuses', () => {
    expect(BALANCER_PROPOSAL_STATUSES).toEqual(['open', 'reviewed', 'dismissed', 'superseded']);
  });

  it('declares the operator decisions and veto reason kinds', () => {
    expect(BALANCER_DECISIONS).toEqual(['acknowledge', 'veto', 'dismiss']);
    expect(BALANCER_VETO_REASON_KINDS).toEqual(['seeding', 'event', 'clan_match', 'other']);
  });

  it('declares the trigger kinds and the current payload schema version', () => {
    expect(BALANCER_TRIGGER_KINDS).toEqual(['win_streak', 'ticket_diff', 'one_sided_rounds']);
    expect(BALANCER_SCHEMA_VERSION).toBe(1);
  });

  it('exposes defaults matching the balancer_settings column defaults', () => {
    expect(DEFAULT_BALANCER_THRESHOLDS).toEqual({
      winStreakThreshold: 3,
      ticketDiffThreshold: 150,
      oneSidedRoundsThreshold: 2,
    });
  });
});

describe('balancer execute-mode boundary (#81 is review/config only)', () => {
  it('adds no live team-change verb to the RCON operator allowlist', () => {
    for (const command of RCON_OPERATOR_COMMANDS) {
      expect(/teamchange|switchteam|forceteam/i.test(command), command).toBe(false);
    }
  });

  it('keeps the operator allowlist at its pre-balancer membership', () => {
    expect([...RCON_OPERATOR_COMMANDS]).toEqual([
      'AdminBan',
      'AdminBroadcast',
      'AdminChangeLayer',
      'AdminEndMatch',
      'AdminKick',
      'AdminReloadServerConfig',
      'AdminSetNextLayer',
      'AdminWarn',
    ]);
  });
});

describe('readBalancerSignals', () => {
  it('reads the snake_case exporter blob into camelCase numbers', () => {
    expect(readBalancerSignals({ win_streak: 4, ticket_diff: -320, one_sided_rounds: 2 })).toEqual({
      winStreak: 4,
      ticketDiff: -320,
      oneSidedRounds: 2,
    });
  });

  it('returns all-null for a non-object blob', () => {
    expect(readBalancerSignals(null)).toEqual({
      winStreak: null,
      ticketDiff: null,
      oneSidedRounds: null,
    });
    expect(readBalancerSignals('nope')).toEqual({
      winStreak: null,
      ticketDiff: null,
      oneSidedRounds: null,
    });
  });

  it('returns all-null for an array blob (exporter drift guard)', () => {
    expect(readBalancerSignals([1, 2, 3])).toEqual({
      winStreak: null,
      ticketDiff: null,
      oneSidedRounds: null,
    });
  });

  it('drops non-numeric and non-finite fields instead of throwing', () => {
    expect(
      readBalancerSignals({
        win_streak: '4',
        ticket_diff: Number.NaN,
        one_sided_rounds: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ winStreak: null, ticketDiff: null, oneSidedRounds: null });
  });

  it('ignores unknown extra fields so a payload change needs no migration', () => {
    expect(
      readBalancerSignals({ win_streak: 1, composition_key: 'abc', schema_version: 9 }),
    ).toEqual({ winStreak: 1, ticketDiff: null, oneSidedRounds: null });
  });
});

describe('evaluateBalancerSignals', () => {
  it('reports healthy with no reasons when every signal is below its threshold', () => {
    expect(
      evaluateBalancerSignals(THRESHOLDS, {
        winStreak: 2,
        ticketDiff: 149,
        oneSidedRounds: 1,
      }),
    ).toEqual({ triggered: false, reasons: [] });
  });

  it('reports healthy when every signal is missing', () => {
    expect(evaluateBalancerSignals(THRESHOLDS, {})).toEqual({ triggered: false, reasons: [] });
  });

  it('triggers on a win streak that reaches the threshold', () => {
    expect(
      evaluateBalancerSignals(THRESHOLDS, { winStreak: 3, ticketDiff: 0, oneSidedRounds: 0 }),
    ).toEqual({
      triggered: true,
      reasons: [{ kind: 'win_streak', observed: 3, threshold: 3 }],
    });
  });

  it('uses the absolute ticket diff so a team-2 blowout also triggers', () => {
    expect(evaluateBalancerSignals(THRESHOLDS, { ticketDiff: -400 })).toEqual({
      triggered: true,
      reasons: [{ kind: 'ticket_diff', observed: 400, threshold: 150 }],
    });
  });

  it('triggers on one-sided rounds and lists every reason in declaration order', () => {
    expect(
      evaluateBalancerSignals(THRESHOLDS, {
        winStreak: 5,
        ticketDiff: 500,
        oneSidedRounds: 4,
      }),
    ).toEqual({
      triggered: true,
      reasons: [
        { kind: 'win_streak', observed: 5, threshold: 3 },
        { kind: 'ticket_diff', observed: 500, threshold: 150 },
        { kind: 'one_sided_rounds', observed: 4, threshold: 2 },
      ],
    });
  });

  it('treats explicit nulls as absent signals', () => {
    expect(
      evaluateBalancerSignals(THRESHOLDS, {
        winStreak: null,
        ticketDiff: null,
        oneSidedRounds: null,
      }),
    ).toEqual({ triggered: false, reasons: [] });
  });
});
