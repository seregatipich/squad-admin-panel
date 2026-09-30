import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from './config';
import { ru } from './dictionaries/ru';
import {
  createTranslator,
  createTranslatorForLocale,
  type Dictionary,
  getDictionary,
  interpolate,
} from './translate';

describe('config', () => {
  it('is Russian-only', () => {
    expect(DEFAULT_LOCALE).toBe('ru');
    expect(LOCALES).toEqual(['ru']);
  });
});

describe('dictionary completeness', () => {
  it('has no empty translations', () => {
    for (const key of Object.keys(ru) as (keyof typeof ru)[]) {
      expect(ru[key], `ru.${key}`).not.toBe('');
    }
  });
});

describe('interpolate', () => {
  it('substitutes named placeholders', () => {
    expect(interpolate('id {steamId} ok', { steamId: '765' })).toBe('id 765 ok');
  });

  it('coerces numeric params to strings', () => {
    expect(interpolate('{n} left', { n: 3 })).toBe('3 left');
  });

  it('leaves unmatched placeholders untouched', () => {
    expect(interpolate('hi {name}', {})).toBe('hi {name}');
    expect(interpolate('hi {name}')).toBe('hi {name}');
  });
});

describe('translator', () => {
  it('resolves keys for the RU dictionary', () => {
    const t = createTranslatorForLocale('ru');
    expect(t('login.steamButton')).toBe('Войти через Steam');
  });

  it('interpolates params into the resolved string', () => {
    const t = createTranslatorForLocale('ru');
    expect(t('login.error.notAuthorized', { steamId: '765611' })).toBe(
      'Steam ID 765611 не имеет доступа к панели. Обратитесь к администратору.',
    );
  });

  it('returns the key itself when a key is missing at runtime', () => {
    // An empty dictionary (cast past the typed signature) exercises the
    // runtime `?? key` fallback for a key with no translation.
    const t = createTranslator({} as unknown as Dictionary);
    expect(t('login.heading')).toBe('login.heading');
  });

  it('getDictionary returns the locale dictionary', () => {
    expect(getDictionary('ru')).toBe(ru);
  });
});
