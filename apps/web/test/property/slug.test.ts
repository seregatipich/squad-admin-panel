import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import { nameToSlug, sanitizeSlug } from '../../src/app/(dashboard)/servers/new/_slug';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

describe('slug auto-generation properties', () => {
  test.prop([fc.string({ minLength: 1, maxLength: 120 })])(
    'nameToSlug always produces empty or API-valid slug',
    (input) => {
      const slug = nameToSlug(input);
      if (slug === '') return;
      expect(slug).toMatch(SLUG_RE);
    },
  );

  test.prop([fc.string({ maxLength: 120 })])('sanitizeSlug never starts with a dash', (input) => {
    const slug = sanitizeSlug(input);
    if (slug.length > 0) expect(slug.startsWith('-')).toBe(false);
  });

  test.prop([fc.string({ maxLength: 200 })])('sanitizeSlug never exceeds 64 chars', (input) => {
    expect(sanitizeSlug(input).length).toBeLessThanOrEqual(64);
  });

  test.prop([
    fc
      .string({ minLength: 1, maxLength: 60 })
      .filter((s) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) && !s.endsWith('-')),
  ])('already-valid latin slugs round-trip through nameToSlug unchanged', (input) => {
    expect(nameToSlug(input)).toBe(input);
  });
});
