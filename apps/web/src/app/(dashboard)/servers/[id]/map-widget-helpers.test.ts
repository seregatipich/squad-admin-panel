import { describe, expect, it } from 'vitest';
import { canSubmitLayer, filterLayers, formatMatchElapsed } from './map-widget-helpers';

describe('formatMatchElapsed', () => {
  const started = '2026-07-14T10:00:00.000Z';

  it('returns em-dash when there is no open match', () => {
    expect(formatMatchElapsed(null, Date.parse(started))).toBe('—');
  });

  it('returns em-dash for an unparseable timestamp', () => {
    expect(formatMatchElapsed('not-a-date', Date.parse(started))).toBe('—');
  });

  it('formats 0 elapsed seconds as "0 мин"', () => {
    expect(formatMatchElapsed(started, Date.parse(started))).toBe('0 мин');
  });

  it('formats 59 elapsed minutes without hours', () => {
    const now = Date.parse(started) + 59 * 60_000;
    expect(formatMatchElapsed(started, now)).toBe('59 мин');
  });

  it('formats over an hour as "H ч MM мин"', () => {
    const now = Date.parse(started) + 65 * 60_000;
    expect(formatMatchElapsed(started, now)).toBe('1 ч 05 мин');
  });

  it('never returns a negative elapsed time when now is before started', () => {
    const now = Date.parse(started) - 5_000;
    expect(formatMatchElapsed(started, now)).toBe('0 мин');
  });
});

describe('canSubmitLayer', () => {
  it('is false when nothing is selected', () => {
    expect(canSubmitLayer(null, false)).toBe(false);
    expect(canSubmitLayer(null, true)).toBe(false);
  });

  it('is false for a deprecated layer without the confirm checkbox', () => {
    expect(canSubmitLayer({ deprecated: true }, false)).toBe(false);
  });

  it('is true for a deprecated layer with the confirm checkbox ticked', () => {
    expect(canSubmitLayer({ deprecated: true }, true)).toBe(true);
  });

  it('is true for a non-deprecated layer regardless of the checkbox', () => {
    expect(canSubmitLayer({ deprecated: false }, false)).toBe(true);
    expect(canSubmitLayer({ deprecated: false }, true)).toBe(true);
  });
});

describe('filterLayers', () => {
  const rows = [
    { name: 'Yehorivka RAAS v11' },
    { name: "Fool's Road AAS v1" },
    { name: 'Narva Skirmish v1' },
  ];

  it('returns every row for an empty/whitespace query', () => {
    expect(filterLayers(rows, '')).toEqual(rows);
    expect(filterLayers(rows, '   ')).toEqual(rows);
  });

  it('matches case-insensitively on a substring', () => {
    expect(filterLayers(rows, 'yehorivka')).toEqual([rows[0]]);
    expect(filterLayers(rows, 'RAAS')).toEqual([rows[0]]);
    expect(filterLayers(rows, "fool's")).toEqual([rows[1]]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterLayers(rows, 'nonexistent')).toEqual([]);
  });
});
