import { describe, expect, it } from 'vitest';
import { CYRILLIC_TO_LATIN, nameToSlug, sanitizeSlug } from './_slug';

describe('nameToSlug', () => {
  it('transliterates cyrillic to latin', () => {
    expect(nameToSlug('Сервер')).toBe('server');
  });

  it('handles mixed cyrillic and latin', () => {
    expect(nameToSlug('My Сервер 1')).toBe('my-server-1');
  });

  it('replaces spaces and special chars with dashes', () => {
    expect(nameToSlug('Hello World!')).toBe('hello-world');
  });

  it('trims leading/trailing dashes', () => {
    expect(nameToSlug('---test---')).toBe('test');
  });

  it('limits to 64 characters', () => {
    const long = 'a'.repeat(100);
    expect(nameToSlug(long).length).toBeLessThanOrEqual(64);
  });

  it('returns empty string for empty input', () => {
    expect(nameToSlug('')).toBe('');
  });
});

describe('sanitizeSlug', () => {
  it('lowercases and strips invalid chars', () => {
    expect(sanitizeSlug('Hello World!')).toBe('hello-world-');
  });

  it('removes leading dashes', () => {
    expect(sanitizeSlug('--test')).toBe('test');
  });

  it('limits to 64 characters', () => {
    const long = 'b'.repeat(100);
    expect(sanitizeSlug(long).length).toBeLessThanOrEqual(64);
  });
});

describe('CYRILLIC_TO_LATIN', () => {
  it('contains all 33 Russian lowercase letters', () => {
    const cyrillic = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
    for (const ch of cyrillic) {
      expect(CYRILLIC_TO_LATIN).toHaveProperty(ch);
    }
  });

  it('maps а to a', () => {
    expect(CYRILLIC_TO_LATIN.а).toBe('a');
  });

  it('maps ж to zh', () => {
    expect(CYRILLIC_TO_LATIN.ж).toBe('zh');
  });
});
