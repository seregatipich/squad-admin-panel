import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  eventEnvelope,
  matchStateChangedPayload,
  playerConnectedPayload,
  playerDisconnectedPayload,
  rconPlayersPolledPayload,
  seedingTransitionPayload,
  serverLifecyclePayload,
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
    expect(eventEnvelope.safeParse({ ...baseEnvelope, type: 'player.teleported' }).success).toBe(
      false,
    );
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
    if (!res.ok) {
      expect(res.errors.length).toBeGreaterThan(0);
    }
  });

  it('returns ok=true with parsed data for a known + valid payload', () => {
    const res = validatePayload('player.connected', {
      steam_id64: '76561198012345678',
      eos_id: null,
      name: 'P',
      ip: null,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { name: string }).name).toBe('P');
    }
  });

  it('validates server.seeding_started / server.seeding_ended payloads', () => {
    const seedingOk = {
      player_count: 42,
      layer: 'Sumari Seed v1',
      live_at: 60,
      hysteresis: 5,
      progress_pct: 70,
    };
    expect(validatePayload('server.seeding_started', seedingOk).ok).toBe(true);
    expect(validatePayload('server.seeding_ended', seedingOk).ok).toBe(true);
  });

  it('handles every entry in PAYLOAD_SCHEMAS dispatch table', () => {
    const lifecycleOk = { pid: 1, reason: null, exit_code: null };
    const lifecycleTypes = [
      'server.ready',
      'server.starting',
      'server.running',
      'server.stopping',
      'server.stopped',
      'server.crashed',
    ] as const;
    for (const t of lifecycleTypes) {
      expect(validatePayload(t, lifecycleOk).ok).toBe(true);
    }
    const matchOk = { from_state: 'pre', to_state: 'live', layer: null, game_mode: null };
    expect(validatePayload('match.started', matchOk).ok).toBe(true);
    expect(validatePayload('match.ended', matchOk).ok).toBe(true);
    expect(
      validatePayload('player.disconnected', {
        steam_id64: '76561198012345678',
        eos_id: null,
        reason: null,
      }).ok,
    ).toBe(true);
    expect(
      validatePayload('rcon.players_polled', {
        players: [],
        polled_at: '2026-04-23T11:20:00.000Z',
        latency_ms: 1,
      }).ok,
    ).toBe(true);
  });
});

describe('EVENT_TYPES contains the seeding transition types', () => {
  it('includes server.seeding_started and server.seeding_ended', () => {
    expect(EVENT_TYPES).toContain('server.seeding_started');
    expect(EVENT_TYPES).toContain('server.seeding_ended');
  });
});

describe('seedingTransitionPayload', () => {
  const validPayload = {
    player_count: 40,
    layer: 'Sumari Seed v1',
    live_at: 60,
    hysteresis: 5,
    progress_pct: 66,
  };

  it('accepts a well-formed payload', () => {
    expect(seedingTransitionPayload.safeParse(validPayload).success).toBe(true);
  });

  it('accepts layer=null (unknown current layer)', () => {
    expect(seedingTransitionPayload.safeParse({ ...validPayload, layer: null }).success).toBe(true);
  });

  it('rejects extra keys (strict)', () => {
    expect(seedingTransitionPayload.safeParse({ ...validPayload, extra: 'nope' }).success).toBe(
      false,
    );
  });

  it('rejects progress_pct out of 0..100 range', () => {
    expect(seedingTransitionPayload.safeParse({ ...validPayload, progress_pct: 101 }).success).toBe(
      false,
    );
    expect(seedingTransitionPayload.safeParse({ ...validPayload, progress_pct: -1 }).success).toBe(
      false,
    );
  });

  it('rejects live_at = 0 (must be positive)', () => {
    expect(seedingTransitionPayload.safeParse({ ...validPayload, live_at: 0 }).success).toBe(false);
  });

  it('rejects negative player_count', () => {
    expect(seedingTransitionPayload.safeParse({ ...validPayload, player_count: -1 }).success).toBe(
      false,
    );
  });
});

describe('exhaustive payload schemas', () => {
  it('player.disconnected accepts a Steam-only payload', () => {
    expect(
      playerDisconnectedPayload.safeParse({
        steam_id64: '76561198012345678',
        eos_id: null,
        reason: 'kicked',
      }).success,
    ).toBe(true);
  });

  it('player.disconnected rejects bad eos_id format', () => {
    expect(
      playerDisconnectedPayload.safeParse({
        steam_id64: '76561198012345678',
        eos_id: 'NOT-HEX',
        reason: null,
      }).success,
    ).toBe(false);
  });

  it('matchStateChangedPayload accepts nullable layer/game_mode', () => {
    expect(
      matchStateChangedPayload.safeParse({
        from_state: 'pre',
        to_state: 'live',
        layer: null,
        game_mode: null,
      }).success,
    ).toBe(true);
  });

  it('matchStateChangedPayload rejects missing to_state', () => {
    expect(
      matchStateChangedPayload.safeParse({
        from_state: 'pre',
        layer: null,
        game_mode: null,
      }).success,
    ).toBe(false);
  });

  it('serverLifecyclePayload rejects pid = 0 (must be positive)', () => {
    expect(
      serverLifecyclePayload.safeParse({ pid: 0, reason: null, exit_code: null }).success,
    ).toBe(false);
  });

  it('serverLifecyclePayload accepts all-null lifecycle fields', () => {
    expect(
      serverLifecyclePayload.safeParse({ pid: null, reason: null, exit_code: null }).success,
    ).toBe(true);
  });

  it('rcon.players_polled exercises optional is_leader / role keys', () => {
    expect(
      rconPlayersPolledPayload.safeParse({
        players: [
          {
            steam_id64: '76561198012345678',
            eos_id: null,
            name: 'Squad Lead',
            team_id: 1,
            squad_id: 2,
            is_leader: true,
            role: 'Rifleman',
          },
        ],
        polled_at: '2026-04-23T11:20:00.000Z',
        latency_ms: 9,
      }).success,
    ).toBe(true);
  });

  it('rcon.players_polled rejects negative latency_ms', () => {
    expect(
      rconPlayersPolledPayload.safeParse({
        players: [],
        polled_at: '2026-04-23T11:20:00.000Z',
        latency_ms: -1,
      }).success,
    ).toBe(false);
  });

  it('player.connected enforces non-empty name', () => {
    expect(
      playerConnectedPayload.safeParse({
        steam_id64: '76561198012345678',
        eos_id: null,
        name: '',
        ip: null,
      }).success,
    ).toBe(false);
  });

  it('player.connected rejects 129-char name', () => {
    expect(
      playerConnectedPayload.safeParse({
        steam_id64: '76561198012345678',
        eos_id: null,
        name: 'x'.repeat(129),
        ip: null,
      }).success,
    ).toBe(false);
  });

  it('eventEnvelope accepts every type in EVENT_TYPES', () => {
    for (const t of EVENT_TYPES) {
      const env = {
        ...baseEnvelope,
        type: t,
        payload: t === 'player.connected' ? baseEnvelope.payload : {},
      };
      expect(eventEnvelope.safeParse(env).success).toBe(true);
    }
  });

  it('eventEnvelope rejects negative version', () => {
    expect(eventEnvelope.safeParse({ ...baseEnvelope, version: -1 }).success).toBe(false);
  });

  it('eventEnvelope rejects bad correlation_id uuid', () => {
    expect(eventEnvelope.safeParse({ ...baseEnvelope, correlation_id: 'nope' }).success).toBe(
      false,
    );
  });

  it('eventEnvelope accepts server_id = null (host-level events)', () => {
    expect(eventEnvelope.safeParse({ ...baseEnvelope, server_id: null }).success).toBe(true);
  });

  it('eventEnvelope accepts actor = null (system event)', () => {
    expect(eventEnvelope.safeParse({ ...baseEnvelope, actor: null }).success).toBe(true);
  });

  it('eventEnvelope rejects bad actor.kind', () => {
    expect(
      eventEnvelope.safeParse({
        ...baseEnvelope,
        actor: { kind: 'bot', id: null },
      }).success,
    ).toBe(false);
  });
});
