import { describe, expect, it } from 'vitest';
import { compareStreams, type StreamEvent } from '../src/shadowDiff.js';

const ev = (type: string, ts: string, payload: unknown = {}): StreamEvent => ({
  type,
  ts,
  payload,
});

describe('compareStreams', () => {
  it('matches identical event sets at 100%', () => {
    const a = [ev('player.connected', '2026-06-12T10:00:00Z', { steam_id: '7656' })];
    const r = compareStreams(a, [...a]);
    expect(r.parityPct).toBe(100);
    expect(r.missingInShadow).toHaveLength(0);
    expect(r.extraInShadow).toHaveLength(0);
  });

  it('tolerates ts skew within 5s for the same type+payload', () => {
    const prod = [ev('match.started', '2026-06-12T10:00:00Z', { layer: 'Yeho' })];
    const shadow = [ev('match.started', '2026-06-12T10:00:03Z', { layer: 'Yeho' })];
    expect(compareStreams(prod, shadow).parityPct).toBe(100);
  });

  it('reports missing types and computes parity', () => {
    const prod = [
      ev('player.connected', '2026-06-12T10:00:00Z', { steam_id: '1' }),
      ev('player.disconnected', '2026-06-12T10:01:00Z', { steam_id: '1' }),
    ];
    const shadow = [ev('player.connected', '2026-06-12T10:00:01Z', { steam_id: '1' })];
    const r = compareStreams(prod, shadow);
    expect(r.parityPct).toBe(50);
    expect(r.missingTypes).toContain('player.disconnected');
  });
});
