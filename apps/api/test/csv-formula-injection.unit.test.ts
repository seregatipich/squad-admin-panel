import { describe, expect, it } from 'vitest';
import { escapeCsvField } from '../src/routes/analytics.js';
import { csvCell } from '../src/routes/whitelist.js';

// Regression tests for findings #359 and #378: CSV/formula injection in the
// statistics and whitelist CSV exports. A player- or admin-controlled value
// that starts with =, +, -, @, a tab, or a carriage return must be prefixed
// with a leading apostrophe so Excel/LibreOffice treat it as literal text
// instead of evaluating it as a formula (e.g. =HYPERLINK(...), -2+3+cmd|...).
describe.each([
  ['escapeCsvField (statistics/analytics CSV export)', escapeCsvField],
  ['csvCell (whitelist CSV export)', csvCell],
])('%s', (_name, escapeFn) => {
  it.each([
    ['=HYPERLINK("http://evil")', '"\'=HYPERLINK(""http://evil"")"'],
    ['+1+2', "'+1+2"],
    ['-2+3+cmd|calc', "'-2+3+cmd|calc"],
    ['@SUM(1,2)', '"\'@SUM(1,2)"'],
    ['\tformula', "'\tformula"],
    ['\rformula', '"\'\rformula"'],
  ])('prefixes a formula-triggering value %s with an apostrophe', (input, expected) => {
    expect(escapeFn(input)).toBe(expected);
  });

  it('leaves ordinary values untouched', () => {
    expect(escapeFn('normal player name')).toBe('normal player name');
  });

  it('still quotes values containing commas, quotes, or newlines', () => {
    expect(escapeFn('a,b')).toBe('"a,b"');
    expect(escapeFn('say "hi"')).toBe('"say ""hi"""');
    expect(escapeFn('line1\nline2')).toBe('"line1\nline2"');
  });

  it('quotes a formula-prefixed value that also needs RFC 4180 quoting', () => {
    expect(escapeFn('=A,B')).toBe(`"'=A,B"`);
  });
});
