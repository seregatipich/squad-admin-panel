import { describe, expect, it } from 'vitest';
import {
  computeReporterVerdict,
  SPAM_REJECTED_THRESHOLD,
  TRUSTED_MIN_ACCURACY,
  TRUSTED_MIN_CONFIRMED,
} from './reporter-stats.js';

describe('computeReporterVerdict', () => {
  it('accuracy is 0 when no reports have been resolved yet', () => {
    const verdict = computeReporterVerdict({
      total: 3,
      resolved: 0,
      rejected: 0,
      confirmed: 0,
      recentRejected: 0,
      previousSpamFlaggedAt: null,
    });
    expect(verdict.accuracy).toBe(0);
    expect(verdict.trusted).toBe(false);
  });

  it('accuracy is confirmed / resolved', () => {
    const verdict = computeReporterVerdict({
      total: 10,
      resolved: 8,
      rejected: 2,
      confirmed: 4,
      recentRejected: 0,
      previousSpamFlaggedAt: null,
    });
    expect(verdict.accuracy).toBeCloseTo(0.5, 10);
  });

  it('trusted requires both the confirmed floor and the accuracy floor', () => {
    // confirmed=4 (below TRUSTED_MIN_CONFIRMED=5) with perfect accuracy -> not trusted
    const belowConfirmedFloor = computeReporterVerdict({
      total: 4,
      resolved: 4,
      rejected: 0,
      confirmed: 4,
      recentRejected: 0,
      previousSpamFlaggedAt: null,
    });
    expect(belowConfirmedFloor.trusted).toBe(false);

    // confirmed=5, resolved such that accuracy is just under TRUSTED_MIN_ACCURACY=0.6 -> not trusted
    const belowAccuracyFloor = computeReporterVerdict({
      total: 9,
      resolved: 9,
      rejected: 0,
      confirmed: 5,
      recentRejected: 0,
      previousSpamFlaggedAt: null,
    });
    expect(belowAccuracyFloor.accuracy).toBeLessThan(TRUSTED_MIN_ACCURACY);
    expect(belowAccuracyFloor.trusted).toBe(false);

    // confirmed=5, resolved=8 -> accuracy 0.625 >= 0.6 -> trusted
    const trusted = computeReporterVerdict({
      total: 8,
      resolved: 8,
      rejected: 0,
      confirmed: TRUSTED_MIN_CONFIRMED,
      recentRejected: 0,
      previousSpamFlaggedAt: null,
    });
    expect(trusted.accuracy).toBeGreaterThanOrEqual(TRUSTED_MIN_ACCURACY);
    expect(trusted.trusted).toBe(true);
  });

  it('flags spam once recentRejected reaches the threshold', () => {
    const belowThreshold = computeReporterVerdict({
      total: SPAM_REJECTED_THRESHOLD - 1,
      resolved: 0,
      rejected: SPAM_REJECTED_THRESHOLD - 1,
      confirmed: 0,
      recentRejected: SPAM_REJECTED_THRESHOLD - 1,
      previousSpamFlaggedAt: null,
    });
    expect(belowThreshold.spamFlaggedAt).toBeNull();

    const atThreshold = computeReporterVerdict({
      total: SPAM_REJECTED_THRESHOLD,
      resolved: 0,
      rejected: SPAM_REJECTED_THRESHOLD,
      confirmed: 0,
      recentRejected: SPAM_REJECTED_THRESHOLD,
      previousSpamFlaggedAt: null,
    });
    expect(atThreshold.spamFlaggedAt).not.toBeNull();
  });

  it('preserves the original spamFlaggedAt (does not re-stamp) while still above threshold', () => {
    const previousSpamFlaggedAt = new Date('2026-01-01T00:00:00.000Z');
    const verdict = computeReporterVerdict({
      total: SPAM_REJECTED_THRESHOLD + 2,
      resolved: 0,
      rejected: SPAM_REJECTED_THRESHOLD + 2,
      confirmed: 0,
      recentRejected: SPAM_REJECTED_THRESHOLD + 2,
      previousSpamFlaggedAt,
    });
    expect(verdict.spamFlaggedAt).toBe(previousSpamFlaggedAt);
  });

  it('clears the spam flag once recentRejected drops below the threshold', () => {
    const previousSpamFlaggedAt = new Date('2026-01-01T00:00:00.000Z');
    const verdict = computeReporterVerdict({
      total: SPAM_REJECTED_THRESHOLD,
      resolved: 0,
      rejected: SPAM_REJECTED_THRESHOLD - 1,
      confirmed: 0,
      recentRejected: SPAM_REJECTED_THRESHOLD - 1,
      previousSpamFlaggedAt,
    });
    expect(verdict.spamFlaggedAt).toBeNull();
  });
});
