import { describe, expect, it } from 'vitest';

import {
  buildDossierQuery,
  DAMAGE_UNAVAILABLE_HINT,
  DOSSIER_PERIODS,
  DOSSIER_WEAPONS_LIMIT,
  type DossierKit,
  type DossierTrendPoint,
  type DossierWeapon,
  fillTrendMonths,
  formatDamage,
  formatKitTime,
  formatWinrate,
  hasAnyDamage,
  LIFETIME_ONLY_NOTE,
  RNSQUADJS_UNAVAILABLE,
  sortKits,
  sortWeapons,
  trendKd,
  trendMonthLabel,
  VEHICLE_UNCATALOGUED_HINT,
  vehicleDisplayName,
  vehicleTitle,
  weaponsCountLabel,
} from './dossier';

/** Collapses the ru-RU U+00A0 group separator so assertions stay readable. */
function plain(value: string): string {
  return value.replace(/\s/g, '');
}

function weapon(overrides: Partial<DossierWeapon> = {}): DossierWeapon {
  return {
    weapon: 'M4A1',
    kills: 0,
    teamkills: 0,
    damage: null,
    shots_events: 0,
    last_used_at: null,
    ...overrides,
  };
}

function kit(overrides: Partial<DossierKit> = {}): DossierKit {
  return { kit: 'Rifleman', seconds: 0, last_played_at: null, ...overrides };
}

function point(month: string, kills: number, deaths: number): DossierTrendPoint {
  return { month, kills, deaths };
}

describe('dossier constants', () => {
  it('exposes the literal copy the tabs render', () => {
    expect(DOSSIER_WEAPONS_LIMIT).toBe(20);
    expect(DAMAGE_UNAVAILABLE_HINT).toBe('Источник не содержит данных об уроне');
    expect(VEHICLE_UNCATALOGUED_HINT).toBe('Нет в каталоге техники');
    expect(LIFETIME_ONLY_NOTE).toBe('Пожизненно, без разбивки по серверам');
    expect(RNSQUADJS_UNAVAILABLE).toBe('Данные RNSquadJS недоступны');
    expect(DOSSIER_PERIODS.map((p) => p.label)).toEqual(['3 мес', '6 мес', '12 мес', 'Всё время']);
    expect(DOSSIER_PERIODS.map((p) => p.months)).toEqual([3, 6, 12, null]);
  });
});

describe('formatDamage', () => {
  it('renders «—» for null and a grouped number otherwise', () => {
    expect(formatDamage(null)).toBe('—');
    expect(formatDamage(0)).toBe('0');
    expect(formatDamage(999)).toBe('999');
    expect(plain(formatDamage(1234567))).toBe('1234567');
    expect(formatDamage(1234567)).not.toBe('1234567');
    expect(formatDamage(12345.6)).toBe(formatDamage(12346));
    expect(formatDamage(Number.NaN)).toBe('—');
  });
});

describe('hasAnyDamage', () => {
  it('is false when every row damage is null', () => {
    expect(hasAnyDamage([])).toBe(false);
    expect(hasAnyDamage([weapon(), weapon()])).toBe(false);
    expect(hasAnyDamage([weapon(), weapon({ damage: 0 })])).toBe(true);
    expect(hasAnyDamage([weapon({ damage: 1200 })])).toBe(true);
  });
});

describe('formatKitTime', () => {
  it('always renders Nч Nм and guards invalid input', () => {
    expect(formatKitTime(3661)).toBe('1ч 1м');
    expect(formatKitTime(125)).toBe('0ч 2м');
    expect(formatKitTime(0)).toBe('0ч 0м');
    expect(formatKitTime(7200)).toBe('2ч 0м');
    expect(formatKitTime(-5)).toBe('—');
    expect(formatKitTime(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatKitTime(Number.NaN)).toBe('—');
  });
});

describe('formatWinrate', () => {
  it('renders a whole percent and «—» without decided matches', () => {
    expect(formatWinrate(null)).toBe('—');
    expect(formatWinrate(0)).toBe('0%');
    expect(formatWinrate(0.5)).toBe('50%');
    expect(formatWinrate(0.6667)).toBe('67%');
    expect(formatWinrate(1)).toBe('100%');
    expect(formatWinrate(Number.NaN)).toBe('—');
  });
});

describe('trendKd', () => {
  it('matches computeKdRatio including the zero-deaths case', () => {
    expect(trendKd(7, 0)).toBe(7);
    expect(trendKd(0, 0)).toBe(0);
    expect(trendKd(10, 4)).toBe(2.5);
    expect(trendKd(0, 3)).toBe(0);
  });
});

describe('trendMonthLabel', () => {
  it('renders MM.YYYY from a YYYY-MM-DD month key', () => {
    expect(trendMonthLabel('2026-01-01')).toBe('01.2026');
    expect(trendMonthLabel('2025-12-01')).toBe('12.2025');
    expect(trendMonthLabel('nonsense')).toBe('nonsense');
  });
});

describe('fillTrendMonths', () => {
  it('returns exactly N consecutive months for a numeric window', () => {
    const filled = fillTrendMonths(
      [point('2026-07-01', 12, 6)],
      6,
      new Date('2026-07-26T10:00:00.000Z'),
    );
    expect(filled).toHaveLength(6);
    expect(filled.map((p) => p.month)).toEqual([
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
    ]);
    expect(filled[5]).toEqual(point('2026-07-01', 12, 6));
    expect(filled[0]).toEqual(point('2026-02-01', 0, 0));
  });

  it('zero-fills a month the API dropped', () => {
    const filled = fillTrendMonths(
      [point('2026-01-01', 30, 10), point('2026-03-01', 40, 20)],
      3,
      new Date('2026-03-15T00:00:00.000Z'),
    );
    expect(filled.map((p) => p.month)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(filled[1]).toEqual(point('2026-02-01', 0, 0));
  });

  it('spans earliest to latest present month for all time', () => {
    const filled = fillTrendMonths(
      [point('2025-11-01', 5, 5), point('2026-02-01', 8, 2)],
      null,
      new Date('2026-07-26T10:00:00.000Z'),
    );
    expect(filled.map((p) => p.month)).toEqual([
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
    ]);
    expect(filled[1]).toEqual(point('2025-12-01', 0, 0));
    expect(filled[3]).toEqual(point('2026-02-01', 8, 2));
  });

  it('returns an empty array for all time with no rows', () => {
    const now = new Date('2026-07-26T10:00:00.000Z');
    expect(fillTrendMonths([], null, now)).toEqual([]);
    // A month key the API cannot produce is dropped rather than looped over.
    expect(fillTrendMonths([point('nonsense', 4, 2)], null, now)).toEqual([]);
    expect(fillTrendMonths([point('nonsense', 4, 2)], 2, now)).toEqual([
      point('2026-06-01', 0, 0),
      point('2026-07-01', 0, 0),
    ]);
  });
});

describe('sortWeapons', () => {
  it('by kills orders desc with a shots_events tiebreak', () => {
    const rows = [
      weapon({ weapon: 'A', kills: 5, shots_events: 10 }),
      weapon({ weapon: 'B', kills: 9, shots_events: 1 }),
      weapon({ weapon: 'C', kills: 5, shots_events: 99 }),
    ];
    expect(sortWeapons(rows, 'kills').map((r) => r.weapon)).toEqual(['B', 'C', 'A']);
  });

  it('by damage sinks null damage to the end', () => {
    const rows = [
      weapon({ weapon: 'A', damage: null, kills: 99 }),
      weapon({ weapon: 'B', damage: 100 }),
      weapon({ weapon: 'C', damage: 900 }),
      weapon({ weapon: 'D', damage: null }),
    ];
    expect(sortWeapons(rows, 'damage').map((r) => r.weapon)).toEqual(['C', 'B', 'A', 'D']);
  });

  it('does not mutate its input', () => {
    const rows = [weapon({ weapon: 'A', kills: 1 }), weapon({ weapon: 'B', kills: 2 })];
    const before = rows.map((r) => r.weapon);
    const sorted = sortWeapons(rows, 'kills');
    expect(rows.map((r) => r.weapon)).toEqual(before);
    expect(sorted).not.toBe(rows);
  });
});

describe('sortKits', () => {
  it('orders by seconds desc', () => {
    const rows = [
      kit({ kit: 'Medic', seconds: 60 }),
      kit({ kit: 'Rifleman', seconds: 7200 }),
      kit({ kit: 'LAT', seconds: 900 }),
    ];
    const sorted = sortKits(rows);
    expect(sorted.map((r) => r.kit)).toEqual(['Rifleman', 'LAT', 'Medic']);
    expect(sorted).not.toBe(rows);
    expect(rows[0].kit).toBe('Medic');
  });
});

describe('vehicleDisplayName', () => {
  it('picks name_ru for ru and name_en for en', () => {
    const row = {
      vehicle_asset_id: 'BP_MRAP_C',
      name_en: 'MRAP',
      name_ru: 'МРАП',
      unlocalized: false,
    };
    expect(vehicleDisplayName(row, 'ru')).toBe('МРАП');
    expect(vehicleDisplayName(row, 'en')).toBe('MRAP');
    expect(vehicleDisplayName({ ...row, name_ru: null }, 'ru')).toBe('MRAP');
    expect(vehicleDisplayName({ ...row, name_en: null }, 'en')).toBe('МРАП');
    expect(vehicleDisplayName({ ...row, name_en: null, name_ru: null }, 'ru')).toBe('BP_MRAP_C');
    expect(vehicleDisplayName({ ...row, name_en: null, name_ru: null }, 'en')).toBe('BP_MRAP_C');
  });

  it('returns the raw asset id when unlocalized', () => {
    expect(
      vehicleDisplayName(
        {
          vehicle_asset_id: 'BP_Unknown_X',
          name_en: 'Ignored',
          name_ru: 'Игнор',
          unlocalized: true,
        },
        'ru',
      ),
    ).toBe('BP_Unknown_X');
  });
});

describe('vehicleTitle', () => {
  it('returns the asset id when localized and the hint when not', () => {
    expect(vehicleTitle({ vehicle_asset_id: 'BP_MRAP_C', unlocalized: false })).toBe('BP_MRAP_C');
    expect(vehicleTitle({ vehicle_asset_id: 'BP_Unknown_X', unlocalized: true })).toBe(
      VEHICLE_UNCATALOGUED_HINT,
    );
  });
});

describe('weaponsCountLabel', () => {
  it('reports shown out of total', () => {
    expect(weaponsCountLabel(20, 137)).toBe('Показано 20 из 137');
    expect(weaponsCountLabel(0, 0)).toBe('Показано 0 из 0');
  });
});

describe('buildDossierQuery', () => {
  it('omits from for all time and includes it for a window', () => {
    const now = new Date('2026-07-26T10:00:00.000Z');
    expect(buildDossierQuery({ serverId: 'all', monthsBack: null, now })).toBe(
      '?serverId=all&weaponsLimit=20',
    );
    expect(buildDossierQuery({ serverId: 'all', monthsBack: 3, now })).toBe(
      '?serverId=all&weaponsLimit=20&from=2026-05-01',
    );
    expect(buildDossierQuery({ serverId: 'all', monthsBack: 12, now })).toBe(
      '?serverId=all&weaponsLimit=20&from=2025-08-01',
    );
    expect(
      buildDossierQuery({
        serverId: '11111111-2222-3333-4444-555555555555',
        monthsBack: null,
        now,
        weaponsLimit: 50,
      }),
    ).toBe('?serverId=11111111-2222-3333-4444-555555555555&weaponsLimit=50');
  });
});
