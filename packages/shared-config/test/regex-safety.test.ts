import { describe, expect, it } from 'vitest';
import { detectDangerousRegex, REGEX_MAX_REPEAT } from '../src/regex-safety.js';

describe('detectDangerousRegex', () => {
  it('accepts linear-time patterns', () => {
    for (const safe of [
      'plain',
      '^admin\\d+$',
      '[a-z]+x',
      '[^0-9]*y',
      '[]a]+',
      '[\\]x]+',
      '(ab)+',
      '(?:ab){3,5}',
      '(a{3})+',
      '(a+)?',
      '(a+){1}',
      '(bad|worse)+',
      '((a|b))*',
      '(?<name>a|b)+',
      '(?<=pre)x+',
      '(?<!no)x+',
      '(?=la)x',
      '(?!la)x',
      'a|aa',
      'x{2,}',
      'a{2,4}?',
      'a+?b*?',
      'a{x}',
      'a{2',
      ')a',
      // Malformed input never throws; callers reject it by compiling first.
      '(?<unclosed',
      '(?x)',
    ]) {
      expect(detectDangerousRegex(safe), safe).toBeNull();
    }
  });

  it('flags a repeated group containing variable-count repetition', () => {
    for (const evil of [
      '(a+)+$',
      '(a*)*',
      '(\\d+)+',
      '([a-z]+)*',
      '((a+))+',
      '(a{1,100}){1,100}$',
      '(.*a){20}',
      '(a?){10}b',
      '(a{2,})+',
      '(?:x(?:y+))+',
    ]) {
      expect(detectDangerousRegex(evil), evil).toBe('nested_quantifier');
    }
  });

  it('flags a repeated group whose alternation branches may overlap', () => {
    for (const evil of [
      '(a|aa)+$',
      '(aa|a)+$',
      '(A|a)+',
      '(\\w|\\d)+$',
      '(?:x|x)+y',
      '([ab]|a)*',
      '(a.|ab)+',
      '(|a)+',
      '(x(a|aa)y)+',
    ]) {
      expect(detectDangerousRegex(evil), evil).toBe('alternation_under_quantifier');
    }
  });

  it('flags any single bounded repetition above the limit', () => {
    const over = REGEX_MAX_REPEAT + 1;
    for (const evil of [
      `a{${over}}`,
      `a{1,${over}}`,
      `\\d{${over},}`,
      `[a]{${over}}`,
      `(ab){${over}}`,
    ]) {
      expect(detectDangerousRegex(evil), evil).toBe('repeat_too_large');
    }
    expect(detectDangerousRegex(`a{${REGEX_MAX_REPEAT}}`)).toBeNull();
  });
});
