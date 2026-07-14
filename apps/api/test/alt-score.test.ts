import { describe, expect, it } from 'vitest';
import { computeAltScore, confidenceFor, DEFAULT_ALT_SCORE_WEIGHTS } from '../src/lib/alt-score.js';

describe('computeAltScore', () => {
  it('scores zero when no signal is triggered', () => {
    expect(
      computeAltScore(
        {
          sharedIpCount: 0,
          sharedNameCount: 0,
          youngAccount: false,
          steamidClose: false,
          coplayOverlap: false,
        },
        DEFAULT_ALT_SCORE_WEIGHTS,
      ),
    ).toBe(0);
  });

  it('adds the shared-IP weight once, regardless of how many non-ignored IPs match', () => {
    const weights = DEFAULT_ALT_SCORE_WEIGHTS;
    expect(
      computeAltScore(
        {
          sharedIpCount: 1,
          sharedNameCount: 0,
          youngAccount: false,
          steamidClose: false,
          coplayOverlap: false,
        },
        weights,
      ),
    ).toBe(weights.weightSharedIp);
    expect(
      computeAltScore(
        {
          sharedIpCount: 7,
          sharedNameCount: 0,
          youngAccount: false,
          steamidClose: false,
          coplayOverlap: false,
        },
        weights,
      ),
    ).toBe(weights.weightSharedIp);
  });

  it('ignored-only matches (sharedIpCount 0) do not contribute the IP weight', () => {
    // The caller passes sharedIpCount = 0 when every shared IP is on the
    // ignore list — the pair still surfaces with its (ignored) matches, but
    // the IP signal must not add to the score.
    expect(
      computeAltScore(
        {
          sharedIpCount: 0,
          sharedNameCount: 0,
          youngAccount: false,
          steamidClose: false,
          coplayOverlap: false,
        },
        DEFAULT_ALT_SCORE_WEIGHTS,
      ),
    ).toBe(0);
  });

  it('sums every triggered signal', () => {
    const weights = DEFAULT_ALT_SCORE_WEIGHTS;
    const score = computeAltScore(
      {
        sharedIpCount: 2,
        sharedNameCount: 3,
        youngAccount: true,
        steamidClose: true,
        coplayOverlap: false,
      },
      weights,
    );
    expect(score).toBe(
      weights.weightSharedIp +
        weights.weightSharedName +
        weights.weightYoungAccount +
        weights.weightSteamidProximity,
    );
  });

  it('applies custom weights instead of the defaults', () => {
    const customWeights = {
      weightSharedIp: 100,
      weightSharedName: 1,
      weightYoungAccount: 0,
      weightSteamidProximity: 0,
      weightCoplayOverlap: 0,
    };
    const score = computeAltScore(
      {
        sharedIpCount: 1,
        sharedNameCount: 1,
        youngAccount: true,
        steamidClose: true,
        coplayOverlap: false,
      },
      customWeights,
    );
    expect(score).toBe(101);
  });

  it('subtracts the coplay-overlap weight when the anti-signal is triggered', () => {
    const weights = DEFAULT_ALT_SCORE_WEIGHTS;
    const score = computeAltScore(
      {
        sharedIpCount: 1,
        sharedNameCount: 0,
        youngAccount: false,
        steamidClose: false,
        coplayOverlap: true,
      },
      weights,
    );
    expect(score).toBe(weights.weightSharedIp - weights.weightCoplayOverlap);
  });

  it('does not subtract anything when coplayOverlap is false', () => {
    const weights = DEFAULT_ALT_SCORE_WEIGHTS;
    const withSignal = computeAltScore(
      {
        sharedIpCount: 1,
        sharedNameCount: 0,
        youngAccount: false,
        steamidClose: false,
        coplayOverlap: false,
      },
      weights,
    );
    expect(withSignal).toBe(weights.weightSharedIp);
  });

  it('does not subtract anything when weightCoplayOverlap is configured to 0', () => {
    const weights = { ...DEFAULT_ALT_SCORE_WEIGHTS, weightCoplayOverlap: 0 };
    const score = computeAltScore(
      {
        sharedIpCount: 1,
        sharedNameCount: 0,
        youngAccount: false,
        steamidClose: false,
        coplayOverlap: true,
      },
      weights,
    );
    expect(score).toBe(weights.weightSharedIp);
  });

  it('can push the score below the medium threshold, dropping confidence (AC in miniature)', () => {
    const weights = DEFAULT_ALT_SCORE_WEIGHTS;
    const thresholds = { mediumThreshold: 50, highThreshold: 75 };
    // shared IP (50) alone would be exactly 'medium'.
    const withoutCoplay = computeAltScore(
      {
        sharedIpCount: 1,
        sharedNameCount: 0,
        youngAccount: false,
        steamidClose: false,
        coplayOverlap: false,
      },
      weights,
    );
    expect(confidenceFor(withoutCoplay, thresholds)).toBe('medium');
    // The coplay anti-signal (30) drags it below the medium threshold.
    const withCoplay = computeAltScore(
      {
        sharedIpCount: 1,
        sharedNameCount: 0,
        youngAccount: false,
        steamidClose: false,
        coplayOverlap: true,
      },
      weights,
    );
    expect(withCoplay).toBeLessThan(withoutCoplay);
    expect(confidenceFor(withCoplay, thresholds)).toBe('low');
  });

  it('returns "low" confidence for a negative total score', () => {
    const weights = DEFAULT_ALT_SCORE_WEIGHTS;
    const thresholds = { mediumThreshold: 50, highThreshold: 75 };
    const score = computeAltScore(
      {
        sharedIpCount: 0,
        sharedNameCount: 0,
        youngAccount: false,
        steamidClose: false,
        coplayOverlap: true,
      },
      weights,
    );
    expect(score).toBeLessThan(0);
    expect(confidenceFor(score, thresholds)).toBe('low');
  });
});

describe('confidenceFor', () => {
  const thresholds = { mediumThreshold: 50, highThreshold: 75 };

  it('is low below the medium threshold', () => {
    expect(confidenceFor(0, thresholds)).toBe('low');
    expect(confidenceFor(49, thresholds)).toBe('low');
  });

  it('is medium exactly at the medium threshold and up to (excluding) high', () => {
    expect(confidenceFor(50, thresholds)).toBe('medium');
    expect(confidenceFor(74, thresholds)).toBe('medium');
  });

  it('is high exactly at the high threshold and above', () => {
    expect(confidenceFor(75, thresholds)).toBe('high');
    expect(confidenceFor(1000, thresholds)).toBe('high');
  });

  it('respects custom thresholds', () => {
    expect(confidenceFor(10, { mediumThreshold: 10, highThreshold: 20 })).toBe('medium');
    expect(confidenceFor(20, { mediumThreshold: 10, highThreshold: 20 })).toBe('high');
  });
});
