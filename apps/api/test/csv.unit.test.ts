import { describe, expect, it } from 'vitest';
import { neutralizeCsvFormula } from '../src/lib/csv.js';
import { escapeCsvField } from '../src/routes/analytics.js';

describe('neutralizeCsvFormula', () => {
  it.each(['=1+1', '+cmd|calc', '-2+3', '@SUM(A1)', '\tx', '\rx'])(
    'prefixes a formula trigger: %j',
    (value) => {
      expect(neutralizeCsvFormula(value)).toBe(`'${value}`);
    },
  );

  it.each(['-5', '+1.5', '0', 'Alpha', '', 'a=b'])('leaves safe text unchanged: %j', (value) => {
    expect(neutralizeCsvFormula(value)).toBe(value);
  });
});

describe('escapeCsvField', () => {
  it('neutralizes before quoting so the quoted cell cannot start a formula', () => {
    expect(escapeCsvField('=HYPERLINK("http://evil","x")')).toBe(
      `"'=HYPERLINK(""http://evil"",""x"")"`,
    );
  });
});
