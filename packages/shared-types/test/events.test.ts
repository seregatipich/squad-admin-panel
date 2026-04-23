import { describe, expect, it } from 'vitest';
import {
  eventEnvelope,
  playerConnectedPayload,
  rconPlayersPolledPayload,
  validatePayload,
} from '../src/events.js';

const baseEnvelope = {
  event_id: '01903f7d-6a15-7c81-aa91-1e4fa9f9b7c4',
  version: 1,
  type: 'player.connected' as const,
  server_id: '01903f7d-6a15-7c81-aa91-1e4fa9f9b7c5',
  ts: '2026-04-23T11:20:00.000Z',
  actor: { kind: 'system' as const, id: null },
  correlation_id: null,
  payload: {
    steam_id64: '76561198012345678',
    eos_id: 'abcdef0123456789abcdef0123456789',
    name: 'PlayerOne',
    ip: '203.0.113.10',
  },
};

describe('event envelope schema', () => {
  it('accepts a well-formed envelope', () => {
    expect(eventEnvelope.safeParse(baseEnvelope).success).toBe(true);
  });

  it('rejects envelope missing event_id', () => {
    const { event_id: _omit, ...rest } = baseEnvelope;
    void _omit;
    expect(eventEnvelope.safeParse(rest).success).toBe(false);
  });

  it('rejects envelope with unknown event type', () => {
    expect(
      eventEnvelope.safeParse({ ...baseEnvelope, type: 'player.teleported' }).success,
    ).toBe(false);
  });

  it('rejects version=0 (must be positive int)', () => {
    expect(eventEnvelope.safeParse({ ...baseEnvelope, version: 0 }).success).toBe(false);
  });

  it('rejects strict additional properties', () => {
    const withExtra = { ...baseEnvelope, extra: 'nope' };
    expect(eventEnvelope.safeParse(withExtra).success).toBe(false);
  });
});

describe('player.connected payload schema', () => {
  it('requires 17-digit steam_id64', () => {
    const bad = { ...baseEnvelope.payload, steam_id64: '123' };
    expect(playerConnectedPayload.safeParse(bad).success).toBe(false);
  });

  it('allows eos_id=null (Steam-only join)', () => {
    const ok = { ...baseEnvelope.payload, eos_id: null };
    expect(playerConnectedPayload.safeParse(ok).success).toBe(true);
  });
});

describe('rcon.players_polled payload schema', () => {
  it('accepts empty player list (server running but no one connected)', () => {
    const parsed = rconPlayersPolledPayload.safeParse({
      players: [],
      polled_at: '2026-04-23T11:20:00.000Z',
      latency_ms: 12,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('validatePayload dispatcher', () => {
  it('returns ok for unknown type (forward compat)', () => {
    const res = validatePayload('server.updated', { some: 'thing' });
    expect(res.ok).toBe(true);
  });

  it('returns errors for mismatched payload', () => {
    const res = validatePayload('player.connected', { steam_id64: 'short' });
    expect(res.ok).toBe(false);
  });
});
