import { describe, expect, it } from 'vitest';
import { normalizePlayerName } from '../src/player-name.js';

describe('normalizePlayerName', () => {
  it('strips a bracketed clan tag and lowercases the base name', () => {
    expect(normalizePlayerName('[MDC] PlayerName')).toBe('playername');
  });

  it('strips leading symbols and preserves cyrillic while lowercasing', () => {
    expect(normalizePlayerName('✪ Mdc︱ Шyxer')).toBe('mdc︱ шyxer');
  });

  it('strips multiple stacked bracket tags', () => {
    expect(normalizePlayerName('[A][B]Name')).toBe('name');
  });

  it('handles angle and paren tags plus cyrillic base', () => {
    expect(normalizePlayerName('  <TAG> Джон')).toBe('джон');
    expect(normalizePlayerName('(Clan) Foo Bar')).toBe('foo bar');
  });

  it('strips a symbol that precedes a bracket tag', () => {
    expect(normalizePlayerName('✪[MDC]Name')).toBe('name');
    expect(normalizePlayerName('[MDC]✪PlayerName')).toBe('playername');
  });

  it('drops leading digits per the non-letter rule', () => {
    expect(normalizePlayerName('1Player')).toBe('player');
    expect(normalizePlayerName('007 Bond')).toBe('bond');
  });

  it('preserves emoji-only names as-is via the fallback', () => {
    expect(normalizePlayerName('😀😀')).toBe('😀😀');
  });

  it('falls back to the trimmed lowercased original when stripping empties the name', () => {
    expect(normalizePlayerName('[Clan]  ')).toBe('[clan]');
    expect(normalizePlayerName('76561198')).toBe('76561198');
  });

  it('collapses internal whitespace and trims', () => {
    expect(normalizePlayerName('  Ghost   Sniper  ')).toBe('ghost sniper');
  });

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(normalizePlayerName('')).toBe('');
    expect(normalizePlayerName('   ')).toBe('');
  });
});
