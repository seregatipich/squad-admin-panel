import { describe, expect, it } from 'vitest';
import { nameToSlug } from '../../src/app/(dashboard)/servers/new/_slug';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// regression: cyrillic-only input produced "---" (400 from API)
// Fix: nameToSlug now transliterates Cyrillic before stripping non-alnum
describe('slug regression: Cyrillic input', () => {
  it('produces a valid non-empty slug for a pure Cyrillic name', () => {
    const slug = nameToSlug('Сервер');
    expect(slug).not.toBe('');
    expect(slug).not.toBe('---');
    expect(slug).toMatch(SLUG_RE);
  });

  it('transliterates "Москва" to "moskva"', () => {
    expect(nameToSlug('Москва')).toBe('moskva');
  });

  it('transliterates mixed Cyrillic+Latin input', () => {
    const slug = nameToSlug('Squad Сервер 1');
    expect(slug).toMatch(SLUG_RE);
    expect(slug).toBe('squad-server-1');
  });

  it('handles all-Cyrillic input that would naively produce only dashes', () => {
    const names = ['Ёж', 'Щука', 'Борец'];
    for (const name of names) {
      const slug = nameToSlug(name);
      expect(slug).not.toBe('');
      expect(slug).toMatch(SLUG_RE);
    }
  });
});
