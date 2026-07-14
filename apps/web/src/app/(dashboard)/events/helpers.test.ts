import { describe, expect, it } from 'vitest';
import {
  appendEventPage,
  buildCountApiQuery,
  buildExportApiQuery,
  buildListApiQuery,
  buildQueryString,
  defaultFilters,
  type EventFilters,
  type EventListItem,
  formatDateTime,
  kindLabel,
  kindOptionsFromEvents,
  kindTone,
  mergeEventPage,
  parseFilters,
  resolveDateRange,
  serverOptionsFromEvents,
  shortServerName,
} from './helpers';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

function makeEvent(overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    event_id: overrides.event_id ?? '11111111-1111-1111-1111-111111111111',
    server_id: overrides.server_id === undefined ? 'srv-1' : overrides.server_id,
    server_name: overrides.server_name === undefined ? 'Main Server' : overrides.server_name,
    server_slug: overrides.server_slug === undefined ? 'main' : overrides.server_slug,
    occurred_at: overrides.occurred_at ?? '2026-07-02T10:00:00.000Z',
    kind: overrides.kind ?? 'player.connected',
    version: overrides.version ?? 1,
    actor_kind: overrides.actor_kind === undefined ? 'system' : overrides.actor_kind,
    actor_id: overrides.actor_id === undefined ? 'plr-1' : overrides.actor_id,
    actor_nickname: overrides.actor_nickname === undefined ? 'Rambo' : overrides.actor_nickname,
    correlation_id: overrides.correlation_id === undefined ? null : overrides.correlation_id,
  };
}

describe('events helpers', () => {
  it('round-trips filters through the query string', () => {
    const filters: EventFilters = {
      servers: ['srv-1', 'srv-2'],
      kinds: ['player.connected', 'match.ended'],
      playerQuery: 'rambo',
      ruleId: '22222222-2222-2222-2222-222222222222',
      preset: 'custom',
      from: '2026-07-01',
      to: '2026-07-31',
      order: 'asc',
    };
    const parsed = parseFilters(params(buildQueryString(filters)));
    expect(parsed).toEqual(filters);
  });

  it('round-trips the rule filter through the "rule" query param', () => {
    const filters: EventFilters = { ...defaultFilters(), ruleId: 'rule-abc' };
    const qs = buildQueryString(filters);
    expect(new URLSearchParams(qs).get('rule')).toBe('rule-abc');
    expect(parseFilters(params(qs))).toEqual(filters);
  });

  it('sends the rule filter as ruleId on list/count/export API queries', () => {
    const filters: EventFilters = { ...defaultFilters(), ruleId: 'rule-abc' };
    for (const qs of [
      buildListApiQuery(filters),
      buildCountApiQuery(filters),
      buildExportApiQuery(filters),
    ]) {
      expect(new URLSearchParams(qs).get('ruleId')).toBe('rule-abc');
    }
  });

  it('defaults to empty desc filters', () => {
    expect(parseFilters(params(''))).toEqual(defaultFilters());
  });

  it('appends repeated serverId and kind params for the API', () => {
    const filters: EventFilters = {
      ...defaultFilters(),
      servers: ['a', 'b'],
      kinds: ['player.connected', 'player.disconnected'],
      playerQuery: 'ghost',
    };
    const qs = buildListApiQuery(filters, { limit: 25 });
    const search = new URLSearchParams(qs);
    expect(search.getAll('serverId')).toEqual(['a', 'b']);
    expect(search.getAll('kind')).toEqual(['player.connected', 'player.disconnected']);
    expect(search.get('playerQuery')).toBe('ghost');
    expect(search.get('order')).toBe('desc');
    expect(search.get('limit')).toBe('25');
  });

  it('locks the server id when provided and ignores filter servers', () => {
    const filters: EventFilters = { ...defaultFilters(), servers: ['ignored'] };
    const search = new URLSearchParams(buildListApiQuery(filters, { lockedServerId: 'locked-id' }));
    expect(search.getAll('serverId')).toEqual(['locked-id']);
  });

  it('adds the csv format flag to the export query', () => {
    const search = new URLSearchParams(
      buildExportApiQuery(defaultFilters(), { lockedServerId: 'srv-x' }),
    );
    expect(search.get('format')).toBe('csv');
    expect(search.getAll('serverId')).toEqual(['srv-x']);
  });

  it('omits pagination fields from the count query', () => {
    const search = new URLSearchParams(buildCountApiQuery(defaultFilters()));
    expect(search.get('limit')).toBeNull();
    expect(search.get('cursor')).toBeNull();
  });

  it('resolves the custom date range to full days', () => {
    const range = resolveDateRange({
      ...defaultFilters(),
      preset: 'custom',
      from: '2026-07-01',
      to: '2026-07-02',
    });
    expect(range.dateFrom?.getHours()).toBe(0);
    expect(range.dateTo?.getHours()).toBe(23);
  });

  it('resolves a fixed 30-day window relative to now', () => {
    const now = new Date('2026-07-31T12:00:00.000Z');
    const range = resolveDateRange({ ...defaultFilters(), preset: '30days' }, now);
    expect(range.dateTo).toEqual(now);
    expect(range.dateFrom).toEqual(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  });

  it('derives server and kind options from loaded events', () => {
    const items = [
      makeEvent({ event_id: 'e1', server_id: 'srv-1', kind: 'player.connected' }),
      makeEvent({ event_id: 'e2', server_id: 'srv-2', kind: 'combat.custom' }),
      makeEvent({ event_id: 'e3', server_id: null }),
    ];
    expect(serverOptionsFromEvents(items).map((entry) => entry.id)).toEqual(['srv-1', 'srv-2']);
    expect(kindOptionsFromEvents(items).map((entry) => entry.value)).toContain('combat.custom');
  });

  it('merges and appends pages without duplicating events', () => {
    const first = makeEvent({ event_id: 'e1' });
    const second = makeEvent({ event_id: 'e2' });
    expect(appendEventPage([first], [first, second]).map((event) => event.event_id)).toEqual([
      'e1',
      'e2',
    ]);
    expect(mergeEventPage([second], [first, second]).map((event) => event.event_id)).toEqual([
      'e2',
      'e1',
    ]);
  });

  it('labels known kinds and tones crash events red', () => {
    expect(kindLabel('player.connected')).toBe('Игрок подключился');
    expect(kindLabel('unknown.kind')).toBe('unknown.kind');
    expect(kindTone('server.crashed')).toContain('red');
    expect(kindTone('player.connected')).toContain('emerald');
  });

  it('labels banname.matched and tones it amber', () => {
    expect(kindLabel('banname.matched')).toBe('Совпадение по запрещённому нику');
    expect(kindTone('banname.matched')).toContain('amber');
  });

  it('falls back through slug, name, id for the server label', () => {
    expect(shortServerName(makeEvent({ server_slug: 'main' }))).toBe('main');
    expect(shortServerName(makeEvent({ server_slug: null, server_name: 'Named' }))).toBe('Named');
    expect(
      shortServerName(
        makeEvent({ server_slug: null, server_name: null, server_id: 'abcdefgh1234' }),
      ),
    ).toBe('abcdefgh');
  });

  it('formats and guards timestamps', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDateTime('2026-07-02T10:00:00.000Z')).not.toBe('—');
  });
});
