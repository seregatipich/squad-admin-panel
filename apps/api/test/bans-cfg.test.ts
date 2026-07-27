import { describe, expect, it } from 'vitest';
import { removeBanLines } from '../src/lib/bans-cfg.js';

describe('removeBanLines', () => {
  it('removes only lines whose steamId matches, preserving comments and blank lines', () => {
    const content = [
      'Banned:76561198000000001:0 // aimbot',
      '',
      '// a plain comment line',
      'Banned:76561198000000002:0 // wallhack',
      '',
    ].join('\n');

    const result = removeBanLines(content, '76561198000000001');

    expect(result.removed).toEqual(['Banned:76561198000000001:0 // aimbot']);
    expect(result.content).toBe(
      ['', '// a plain comment line', 'Banned:76561198000000002:0 // wallhack', ''].join('\n'),
    );
    expect(result.eol).toBe('\n');
  });

  it('preserves CRLF line endings byte-for-byte', () => {
    const content = [
      'Banned:76561198000000001:0 // aimbot',
      'Banned:76561198000000002:0 // wallhack',
      '',
    ].join('\r\n');

    const result = removeBanLines(content, '76561198000000001');

    expect(result.eol).toBe('\r\n');
    expect(result.content).toBe(['Banned:76561198000000002:0 // wallhack', ''].join('\r\n'));
    expect(result.removed).toEqual(['Banned:76561198000000001:0 // aimbot']);
  });

  it('returns an empty removed list when the player has no ban line', () => {
    const content = ['Banned:76561198000000002:0 // wallhack', ''].join('\n');

    const result = removeBanLines(content, '76561198000000001');

    expect(result.removed).toEqual([]);
    expect(result.content).toBe(content);
  });

  it('removes every matching line when the player was banned more than once', () => {
    const content = [
      'Banned:76561198000000001:0 // first ban',
      'Banned:76561198000000002:0 // unrelated',
      'Banned:76561198000000001:1700000000 // second ban',
      '',
    ].join('\n');

    const result = removeBanLines(content, '76561198000000001');

    expect(result.removed).toEqual([
      'Banned:76561198000000001:0 // first ban',
      'Banned:76561198000000001:1700000000 // second ban',
    ]);
    expect(result.content).toBe(['Banned:76561198000000002:0 // unrelated', ''].join('\n'));
  });

  it('keeps a line whose steamId shares a prefix with the target', () => {
    const content = [
      'Banned:76561198000000001:0 // target',
      'Banned:765611980000000012:0 // prefix-sharing but different length',
      '',
    ].join('\n');

    const result = removeBanLines(content, '76561198000000001');

    expect(result.removed).toEqual(['Banned:76561198000000001:0 // target']);
    expect(result.content).toBe(
      ['Banned:765611980000000012:0 // prefix-sharing but different length', ''].join('\n'),
    );
  });
});
