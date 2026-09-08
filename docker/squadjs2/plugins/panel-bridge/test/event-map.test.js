import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapEvent } from '../src/panel-bridge/event-map.js';

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const fixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

const rawEvents = fixture('squadjs2-events.json');
const expectedEnvelopes = fixture('expected-envelopes.json');

describe('mapEvent against the SquadJS2 golden fixture', () => {
  it.each(expectedEnvelopes)('maps $event (#$index) to $type', (expected) => {
    const captured = rawEvents[expected.index];
    expect(captured.event).toBe(expected.event);

    const envelope = mapEvent(SERVER_ID, captured.event, captured.data ?? {});

    expect(envelope).not.toBeNull();
    expect(envelope.type).toBe(expected.type);
    expect(envelope.payload).toEqual(expected.payload);
    expect(envelope.version).toBe(1);
    expect(envelope.server_id).toBe(SERVER_ID);
    expect(envelope.actor).toEqual({ kind: 'system', id: null });
    expect(envelope.correlation_id).toBeNull();
    expect(envelope.ts).toBe(new Date(expected.ts).toISOString());
    expect(envelope.event_id).toMatch(UUID_V7);
  });

  it('covers every raw event type the fixture captured except the polling snapshot', () => {
    const mappedTypes = new Set(expectedEnvelopes.map((e) => e.event));
    const rawTypes = new Set(rawEvents.map((e) => e.event));
    rawTypes.delete('UPDATED_PLAYER_INFORMATION');
    expect([...rawTypes].sort()).toEqual([...mappedTypes].sort());
  });
});

describe('mapEvent edge cases', () => {
  it('returns null for an event type outside the panel contract', () => {
    expect(mapEvent(SERVER_ID, 'PLAYER_TEAM_CHANGE', { time: new Date() })).toBeNull();
  });

  it('reads connect identifiers from the resolved player object only', () => {
    // SquadJS2 deletes the top-level steamID/eosID before emit (core/id-parser
    // playerIdNames), so a mapper reading them would silently publish nulls.
    const envelope = mapEvent(SERVER_ID, 'PLAYER_CONNECTED', {
      time: '2026-09-08T02:43:10.203Z',
      ip: '10.0.0.11',
      player: { steamID: '76561199000000001', eosID: 'a'.repeat(32), name: 'PanelAlpha' },
    });
    expect(envelope.payload).toEqual({
      steam_id64: '76561199000000001',
      eos_id: 'a'.repeat(32),
      name: 'PanelAlpha',
      ip: null,
    });
  });

  it('publishes nulls when the player list has not caught up with a disconnect', () => {
    const envelope = mapEvent(SERVER_ID, 'PLAYER_DISCONNECTED', {
      time: '2026-09-08T03:19:54.401Z',
      player: null,
    });
    expect(envelope.payload).toEqual({ steam_id64: null, eos_id: null, reason: null });
  });

  it('normalizes a Date time into a full ISO datetime string', () => {
    const envelope = mapEvent(SERVER_ID, 'ADMIN_BROADCAST', {
      message: 'gg',
      time: new Date('2026-09-08T10:00:00.000Z'),
    });
    expect(envelope.ts).toBe('2026-09-08T10:00:00.000Z');
  });

  it('falls back to the current time when raw.time is unparseable', () => {
    const before = Date.now();
    const envelope = mapEvent(SERVER_ID, 'ADMIN_BROADCAST', { message: 'gg', time: 'not-a-date' });
    const ts = Date.parse(envelope.ts);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
  });

  it('omits vehicle for PLAYER_UNPOSSESS, which carries no possess classname', () => {
    const envelope = mapEvent(SERVER_ID, 'PLAYER_UNPOSSESS', {
      time: '2026-09-08T03:20:00.790Z',
      player: { name: 'PanelAlpha' },
    });
    // The published bytes are what the contract fixes: an absent classname must
    // not surface as a `vehicle` key in the stream, exactly as under RNSquadJS.
    expect(Object.hasOwn(JSON.parse(JSON.stringify(envelope.payload)), 'vehicle')).toBe(false);
  });
});
