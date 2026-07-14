import { describe, expect, it } from 'vitest';
import {
  addLayer,
  buildSavePayload,
  filterPool,
  type LayerRow,
  moveEntry,
  type RotationEntry,
  removeAt,
  toRotationEntry,
} from './helpers';

function entry(layer: string, overrides: Partial<RotationEntry> = {}): RotationEntry {
  return {
    layer,
    known: true,
    map: 'Yehorivka',
    gamemode: 'RAAS',
    version: 'v11',
    is_seed: false,
    deprecated: false,
    ...overrides,
  };
}

function layerRow(overrides: Partial<LayerRow> = {}): LayerRow {
  return {
    id: 'id-1',
    name: 'Yehorivka RAAS v11',
    map: 'Yehorivka',
    gamemode: 'RAAS',
    version: 'v11',
    is_seed: false,
    deprecated: false,
    ...overrides,
  };
}

describe('moveEntry', () => {
  it('moves an entry from one index to another', () => {
    const list = [entry('A'), entry('B'), entry('C')];
    const result = moveEntry(list, 0, 2);
    expect(result.map((e) => e.layer)).toEqual(['B', 'C', 'A']);
  });

  it('moves an entry backwards', () => {
    const list = [entry('A'), entry('B'), entry('C')];
    const result = moveEntry(list, 2, 0);
    expect(result.map((e) => e.layer)).toEqual(['C', 'A', 'B']);
  });

  it('clamps the destination index to the list bounds', () => {
    const list = [entry('A'), entry('B'), entry('C')];
    expect(moveEntry(list, 0, 99).map((e) => e.layer)).toEqual(['B', 'C', 'A']);
    expect(moveEntry(list, 2, -5).map((e) => e.layer)).toEqual(['C', 'A', 'B']);
  });

  it('returns the list unchanged for an out-of-range source index', () => {
    const list = [entry('A'), entry('B')];
    expect(moveEntry(list, -1, 0)).toEqual(list);
    expect(moveEntry(list, 5, 0)).toEqual(list);
  });

  it('does not mutate the input list', () => {
    const list = [entry('A'), entry('B')];
    moveEntry(list, 0, 1);
    expect(list.map((e) => e.layer)).toEqual(['A', 'B']);
  });
});

describe('addLayer / removeAt', () => {
  it('appends an entry to the end', () => {
    const list = [entry('A')];
    expect(addLayer(list, entry('B')).map((e) => e.layer)).toEqual(['A', 'B']);
  });

  it('removes the entry at the given index', () => {
    const list = [entry('A'), entry('B'), entry('C')];
    expect(removeAt(list, 1).map((e) => e.layer)).toEqual(['A', 'C']);
  });
});

describe('toRotationEntry', () => {
  it('converts a catalog row into a known rotation entry', () => {
    expect(toRotationEntry(layerRow({ name: 'Gorodok RAAS v1', map: 'Gorodok' }))).toEqual(
      entry('Gorodok RAAS v1', { map: 'Gorodok' }),
    );
  });
});

describe('filterPool', () => {
  const pool = [
    layerRow({ id: '1', name: 'Yehorivka RAAS v11', map: 'Yehorivka', gamemode: 'RAAS' }),
    layerRow({ id: '2', name: 'Gorodok RAAS v1', map: 'Gorodok', gamemode: 'RAAS' }),
    layerRow({ id: '3', name: 'Narva Seed v1', map: 'Narva', gamemode: 'Seed', is_seed: true }),
  ];

  it('filters by map', () => {
    expect(filterPool(pool, { map: 'Gorodok' }).map((l) => l.name)).toEqual(['Gorodok RAAS v1']);
  });

  it('filters by gamemode', () => {
    expect(filterPool(pool, { gamemode: 'Seed' }).map((l) => l.name)).toEqual(['Narva Seed v1']);
  });

  it('filters by seedOnly', () => {
    expect(filterPool(pool, { seedOnly: true }).map((l) => l.name)).toEqual(['Narva Seed v1']);
  });

  it('filters by a case-insensitive name substring', () => {
    expect(filterPool(pool, { query: 'yehor' }).map((l) => l.name)).toEqual(['Yehorivka RAAS v11']);
  });

  it('ANDs multiple filters together', () => {
    expect(filterPool(pool, { map: 'Yehorivka', gamemode: 'RAAS' }).map((l) => l.name)).toEqual([
      'Yehorivka RAAS v11',
    ]);
    expect(filterPool(pool, { map: 'Narva', gamemode: 'RAAS' })).toEqual([]);
  });

  it('returns the full pool when no filters are set', () => {
    expect(filterPool(pool, {})).toEqual(pool);
  });
});

describe('buildSavePayload', () => {
  it('returns layer names in display order', () => {
    const list = [entry('A'), entry('B'), entry('C')];
    expect(buildSavePayload(list)).toEqual({ layers: ['A', 'B', 'C'] });
  });

  it('returns an empty array for an empty rotation', () => {
    expect(buildSavePayload([])).toEqual({ layers: [] });
  });
});
