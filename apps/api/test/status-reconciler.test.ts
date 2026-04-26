import { describe, expect, it } from 'vitest';
import {
  mapState,
  RECONCILE_INTERVAL_MS,
  STUCK_AFTER_MS,
  STUCK_CANDIDATE_STATES,
  TRANSIENT_STATES,
} from '../src/plugins/status-reconciler.js';

describe('mapState', () => {
  it('returns running when running flag is true regardless of state string', () => {
    expect(mapState('running', true)).toEqual({ status: 'running', known: true });
    expect(mapState('exited', true)).toEqual({ status: 'running', known: true });
    expect(mapState('weird-state', true)).toEqual({ status: 'running', known: true });
  });

  it('maps docker exited/dead/not_found to stopped', () => {
    expect(mapState('exited', false)).toEqual({ status: 'stopped', known: true });
    expect(mapState('dead', false)).toEqual({ status: 'stopped', known: true });
    expect(mapState('not_found', false)).toEqual({ status: 'stopped', known: true });
  });

  it('maps docker created/restarting to starting', () => {
    expect(mapState('created', false)).toEqual({ status: 'starting', known: true });
    expect(mapState('restarting', false)).toEqual({ status: 'starting', known: true });
  });

  it('maps docker removing/paused to stopping', () => {
    expect(mapState('removing', false)).toEqual({ status: 'stopping', known: true });
    expect(mapState('paused', false)).toEqual({ status: 'stopping', known: true });
  });

  it('flags unknown states as not-known so the caller can warn', () => {
    expect(mapState('unknown', false)).toEqual({ status: null, known: false });
    expect(mapState('', false)).toEqual({ status: null, known: false });
  });

  it('treats state string case-insensitively and ignores surrounding whitespace', () => {
    expect(mapState(' EXITED ', false)).toEqual({ status: 'stopped', known: true });
    expect(mapState('Restarting', false)).toEqual({ status: 'starting', known: true });
  });
});

describe('reconciler constants', () => {
  it('STUCK_CANDIDATE_STATES is a subset of TRANSIENT_STATES', () => {
    for (const s of STUCK_CANDIDATE_STATES) {
      expect(TRANSIENT_STATES.has(s)).toBe(true);
    }
  });

  it('STUCK_AFTER_MS is well above the polling interval', () => {
    expect(STUCK_AFTER_MS).toBeGreaterThan(RECONCILE_INTERVAL_MS * 5);
  });
});
