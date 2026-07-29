import { describe, expect, it } from 'vitest';
import {
  appendPage,
  buildExportApiQuery,
  buildListApiQuery,
  buildQueryString,
  COMBAT_FACETS,
  type CombatApiRow,
  type CombatFilters,
  type CombatLiveEventData,
  combatEventToRow,
  defaultFilters,
  eventTypeMeta,
  facetLabel,
  facetToApiParams,
  formatDamage,
  formatEventTime,
  LIVE_CAP,
  parseFilters,
  playerHref,
  prependLiveRow,
  resolveDateRange,
  showsDamageColumn,
  sortRowsByDamage,
} from './helpers';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

function makeRow(overrides: Partial<CombatApiRow> = {}): CombatApiRow {
  return {
    id: overrides.id ?? 1,
    eventType: overrides.eventType ?? 'death',
    serverId: overrides.serverId ?? '00000000-0000-0000-0000-000000000001',
    matchId: overrides.matchId === undefined ? null : overrides.matchId,
    weapon: overrides.weapon === undefined ? 'BP_AK74' : overrides.weapon,
    damage: overrides.damage === undefined ? null : overrides.damage,
    attackerKit: overrides.attackerKit === undefined ? null : overrides.attackerKit,
    isTeamkill: overrides.isTeamkill ?? false,
    occurredAt: overrides.occurredAt ?? '2026-07-02T10:00:00.000Z',
    attacker:
      overrides.attacker === undefined
        ? { player_id: 'attacker-1', current_name: 'Rambo' }
        : overrides.attacker,
    victim: overrides.victim ?? { player_id: 'victim-1', current_name: 'Target' },
  };
}

describe('facetToApiParams', () => {
  it('maps kill and death facets to the death event type', () => {
    expect(facetToApiParams('kills')).toEqual({ type: ['death'] });
    expect(facetToApiParams('deaths')).toEqual({ type: ['death'] });
  });

  it('maps wound, revive and damage facets to their event type', () => {
    expect(facetToApiParams('wounds')).toEqual({ type: ['wound'] });
    expect(facetToApiParams('revives')).toEqual({ type: ['revive'] });
    expect(facetToApiParams('damage')).toEqual({ type: ['damage'] });
  });

  it('maps the teamkills facet to the teamkillsOnly flag with no type filter', () => {
    expect(facetToApiParams('teamkills')).toEqual({ teamkillsOnly: true });
  });

  it('covers every facet in COMBAT_FACETS', () => {
    for (const facet of COMBAT_FACETS) {
      const mapped = facetToApiParams(facet);
      expect(mapped.type !== undefined || mapped.teamkillsOnly === true).toBe(true);
      expect(facetLabel(facet).length).toBeGreaterThan(0);
    }
  });
});

describe('showsDamageColumn', () => {
  it('is visible only in the damage facet', () => {
    expect(showsDamageColumn('damage')).toBe(true);
    expect(showsDamageColumn('kills')).toBe(false);
    expect(showsDamageColumn('teamkills')).toBe(false);
  });
});

describe('resolveDateRange', () => {
  const now = new Date('2026-07-05T12:00:00.000Z');

  it('returns an empty range for the all-time preset', () => {
    expect(resolveDateRange({ ...defaultFilters(), preset: 'all' }, now)).toEqual({});
  });

  it('returns a rolling 24h window', () => {
    const range = resolveDateRange({ ...defaultFilters(), preset: '24h' }, now);
    expect(range.dateTo?.toISOString()).toBe(now.toISOString());
    expect(range.dateFrom?.getTime()).toBe(now.getTime() - 24 * 60 * 60 * 1000);
  });

  it('returns rolling windows for 30/60/90 day presets', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(
      resolveDateRange({ ...defaultFilters(), preset: '30days' }, now).dateFrom?.getTime(),
    ).toBe(now.getTime() - 30 * day);
    expect(
      resolveDateRange({ ...defaultFilters(), preset: '60days' }, now).dateFrom?.getTime(),
    ).toBe(now.getTime() - 60 * day);
    expect(
      resolveDateRange({ ...defaultFilters(), preset: '90days' }, now).dateFrom?.getTime(),
    ).toBe(now.getTime() - 90 * day);
  });

  it('parses a custom range from local date inputs', () => {
    const range = resolveDateRange(
      { ...defaultFilters(), preset: 'custom', from: '2026-01-01', to: '2026-01-31' },
      now,
    );
    expect(range.dateFrom).toBeInstanceOf(Date);
    expect(range.dateTo).toBeInstanceOf(Date);
    expect(range.dateFrom?.getHours()).toBe(0);
    expect(range.dateTo?.getHours()).toBe(23);
  });
});

describe('parseFilters / buildQueryString', () => {
  it('round-trips a deep-linkable filter set', () => {
    const filters: CombatFilters = {
      facet: 'damage',
      attackerQuery: 'Rambo',
      attackerPlayerId: '',
      victimQuery: 'Target',
      victimPlayerId: '',
      weapon: 'AK74',
      serverIds: ['srv-a', 'srv-b'],
      preset: '90days',
      from: '',
      to: '',
    };
    const qs = buildQueryString(filters);
    expect(parseFilters(params(qs))).toEqual(filters);
  });

  it('defaults to the kills facet and all-time preset', () => {
    const parsed = parseFilters(params(''));
    expect(parsed.facet).toBe('kills');
    expect(parsed.preset).toBe('all');
    expect(parsed.serverIds).toEqual([]);
  });

  it('falls back to kills for an unknown facet', () => {
    expect(parseFilters(params('facet=bogus')).facet).toBe('kills');
  });

  it('omits custom dates unless the custom preset is active', () => {
    const qs = buildQueryString({
      ...defaultFilters(),
      preset: 'week',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(qs).not.toContain('from=');
    expect(qs).not.toContain('to=');
  });
});

describe('buildListApiQuery', () => {
  const now = new Date('2026-07-05T12:00:00.000Z');

  it('appends the facet type filter and paging params', () => {
    const qs = buildListApiQuery(defaultFilters(), { now, limit: 100 });
    const parsed = params(qs);
    expect(parsed.getAll('type')).toEqual(['death']);
    expect(parsed.get('limit')).toBe('100');
    expect(parsed.get('cursor')).toBeNull();
  });

  it('sends teamkillsOnly and no type filter for the teamkills facet', () => {
    const qs = buildListApiQuery({ ...defaultFilters(), facet: 'teamkills' }, { now });
    const parsed = params(qs);
    expect(parsed.getAll('type')).toEqual([]);
    expect(parsed.get('teamkillsOnly')).toBe('true');
  });

  it('maps Кто/Кого/weapon to substring filters', () => {
    const qs = buildListApiQuery(
      { ...defaultFilters(), attackerQuery: 'Rambo', victimQuery: 'Target', weapon: 'AK' },
      { now },
    );
    const parsed = params(qs);
    expect(parsed.get('attackerName')).toBe('Rambo');
    expect(parsed.get('victimName')).toBe('Target');
    expect(parsed.get('weapon')).toBe('AK');
  });

  it('maps hidden player id filters to exact API filters for deep links', () => {
    const qs = buildListApiQuery(
      {
        ...defaultFilters(),
        facet: 'teamkills',
        attackerPlayerId: '00000000-0000-0000-0000-000000000001',
        victimPlayerId: '00000000-0000-0000-0000-000000000002',
      },
      { now },
    );
    const parsed = params(qs);
    expect(parsed.get('teamkillsOnly')).toBe('true');
    expect(parsed.get('attackerPlayerId')).toBe('00000000-0000-0000-0000-000000000001');
    expect(parsed.get('victimPlayerId')).toBe('00000000-0000-0000-0000-000000000002');
  });

  it('locks the server when a lockedServerId is provided', () => {
    const qs = buildListApiQuery(
      { ...defaultFilters(), serverIds: ['ignored'] },
      { now, lockedServerId: 'locked-server' },
    );
    const parsed = params(qs);
    expect(parsed.getAll('serverId')).toEqual(['locked-server']);
  });

  it('sends multiselect servers when unlocked', () => {
    const qs = buildListApiQuery({ ...defaultFilters(), serverIds: ['srv-a', 'srv-b'] }, { now });
    expect(params(qs).getAll('serverId')).toEqual(['srv-a', 'srv-b']);
  });

  it('translates presets into an ISO from/to window', () => {
    const qs = buildListApiQuery({ ...defaultFilters(), preset: '24h' }, { now });
    const parsed = params(qs);
    expect(parsed.get('from')).toBe(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
    expect(parsed.get('to')).toBe(now.toISOString());
  });
});

describe('buildExportApiQuery', () => {
  it('carries the filters and requests csv format without paging', () => {
    const qs = buildExportApiQuery(
      { ...defaultFilters(), facet: 'damage', weapon: 'AK' },
      { now: new Date('2026-07-05T12:00:00.000Z') },
    );
    const parsed = params(qs);
    expect(parsed.get('format')).toBe('csv');
    expect(parsed.getAll('type')).toEqual(['damage']);
    expect(parsed.get('weapon')).toBe('AK');
    expect(parsed.get('limit')).toBeNull();
    expect(parsed.get('cursor')).toBeNull();
  });
});

describe('row rendering helpers', () => {
  it('links both attacker and victim to their player cards', () => {
    const row = makeRow();
    expect(playerHref(row.attacker)).toBe('/all-players/attacker-1');
    expect(playerHref(row.victim)).toBe('/all-players/victim-1');
  });

  it('returns null href when the attacker is unknown', () => {
    expect(playerHref(null)).toBeNull();
    expect(playerHref({ player_id: '', current_name: null })).toBeNull();
  });

  it('formats damage numbers and dashes null damage', () => {
    expect(formatDamage('45.5')).toBe('45.5');
    expect(formatDamage('100.00')).toBe('100');
    expect(formatDamage(null)).toBe('—');
  });

  it('renders a localized time string', () => {
    expect(formatEventTime('2026-07-02T10:00:00.000Z')).not.toBe('—');
    expect(formatEventTime('not-a-date')).toBe('—');
  });

  it('exposes a badge label for each event type', () => {
    expect(eventTypeMeta('death').labelRu).toBeTruthy();
    expect(eventTypeMeta('wound').labelRu).toBeTruthy();
    expect(eventTypeMeta('revive').labelRu).toBeTruthy();
    expect(eventTypeMeta('damage').labelRu).toBeTruthy();
    expect(eventTypeMeta('unknown').labelRu).toBe('unknown');
  });
});

describe('sortRowsByDamage', () => {
  it('sorts descending by numeric damage, nulls last', () => {
    const rows = [
      makeRow({ id: 1, damage: '10' }),
      makeRow({ id: 2, damage: null }),
      makeRow({ id: 3, damage: '50' }),
    ];
    expect(sortRowsByDamage(rows, 'desc').map((row) => row.id)).toEqual([3, 1, 2]);
  });

  it('sorts ascending by numeric damage, nulls last', () => {
    const rows = [
      makeRow({ id: 1, damage: '10' }),
      makeRow({ id: 2, damage: null }),
      makeRow({ id: 3, damage: '50' }),
    ];
    expect(sortRowsByDamage(rows, 'asc').map((row) => row.id)).toEqual([1, 3, 2]);
  });

  it('does not mutate the input array', () => {
    const rows = [makeRow({ id: 1, damage: '10' }), makeRow({ id: 2, damage: '50' })];
    sortRowsByDamage(rows, 'desc');
    expect(rows.map((row) => row.id)).toEqual([1, 2]);
  });
});

describe('appendPage', () => {
  it('appends new rows and drops duplicates by id', () => {
    const existing = [makeRow({ id: 1 }), makeRow({ id: 2 })];
    const incoming = [makeRow({ id: 2 }), makeRow({ id: 3 })];
    expect(appendPage(existing, incoming).map((row) => row.id)).toEqual([1, 2, 3]);
  });
});

function liveEvent(overrides: Partial<CombatLiveEventData> = {}): CombatLiveEventData {
  return {
    server_id: '00000000-0000-0000-0000-000000000001',
    match_id: null,
    kind: 'combat_death',
    attacker_player_id: 'attacker-1',
    victim_player_id: 'victim-1',
    weapon: 'BP_AK74',
    damage: 45.5,
    is_teamkill: false,
    is_suicide: false,
    occurred_at: '2026-07-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('combatEventToRow', () => {
  it('maps every combat.event kind to the matching REST event type', () => {
    expect(combatEventToRow(liveEvent({ kind: 'combat_damage' })).eventType).toBe('damage');
    expect(combatEventToRow(liveEvent({ kind: 'combat_wound' })).eventType).toBe('wound');
    expect(combatEventToRow(liveEvent({ kind: 'combat_death' })).eventType).toBe('death');
    expect(combatEventToRow(liveEvent({ kind: 'combat_revive' })).eventType).toBe('revive');
  });

  it('carries the teamkill flag through', () => {
    expect(combatEventToRow(liveEvent({ is_teamkill: true })).isTeamkill).toBe(true);
    expect(combatEventToRow(liveEvent({ is_teamkill: false })).isTeamkill).toBe(false);
  });

  it('always maps player names to null (unavailable on the live payload)', () => {
    const row = combatEventToRow(liveEvent());
    expect(row.attacker?.current_name).toBeNull();
    expect(row.victim?.current_name).toBeNull();
    expect(row.attacker?.player_id).toBe('attacker-1');
    expect(row.victim?.player_id).toBe('victim-1');
  });

  it('maps a missing attacker or victim id to null instead of an empty ref', () => {
    const row = combatEventToRow(liveEvent({ attacker_player_id: null, victim_player_id: null }));
    expect(row.attacker).toBeNull();
    expect(row.victim).toBeNull();
  });

  it('stringifies numeric damage and passes through null damage', () => {
    expect(combatEventToRow(liveEvent({ damage: 100 })).damage).toBe('100');
    expect(combatEventToRow(liveEvent({ damage: null })).damage).toBeNull();
  });

  it('produces a negative synthetic id that never collides with a real row id', () => {
    const row = combatEventToRow(liveEvent());
    expect(row.id).toBeLessThan(0);
  });

  it('is deterministic for the same payload and distinct for a different one', () => {
    const first = combatEventToRow(liveEvent());
    const second = combatEventToRow(liveEvent());
    const third = combatEventToRow(liveEvent({ occurred_at: '2026-07-09T10:00:01.000Z' }));
    expect(second.id).toBe(first.id);
    expect(third.id).not.toBe(first.id);
  });
});

describe('prependLiveRow', () => {
  it('prepends the incoming row ahead of the current list', () => {
    const current = [makeRow({ id: 1 })];
    const next = prependLiveRow(current, makeRow({ id: 2 }));
    expect(next.map((row) => row.id)).toEqual([2, 1]);
  });

  it('drops a duplicate by id instead of prepending it again', () => {
    const current = [makeRow({ id: 1 }), makeRow({ id: 2 })];
    const next = prependLiveRow(current, makeRow({ id: 2 }));
    expect(next.map((row) => row.id)).toEqual([1, 2]);
  });

  it('caps the list length, dropping the oldest rows', () => {
    let rows: CombatApiRow[] = [];
    for (let i = 0; i < 5; i++) rows = prependLiveRow(rows, makeRow({ id: i }), 3);
    expect(rows.map((row) => row.id)).toEqual([4, 3, 2]);
  });

  it('defaults to the LIVE_CAP constant when no cap is given', () => {
    let rows: CombatApiRow[] = [];
    for (let i = 0; i < LIVE_CAP + 5; i++) rows = prependLiveRow(rows, makeRow({ id: i }));
    expect(rows).toHaveLength(LIVE_CAP);
    expect(rows[0]?.id).toBe(LIVE_CAP + 4);
  });
});
