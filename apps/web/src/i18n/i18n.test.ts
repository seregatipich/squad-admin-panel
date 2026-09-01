import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from './config';
import { ru } from './dictionaries/ru';
import { extractApiErrorCode, localizeApiError } from './errors';
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
    expect(t('login.redirecting')).toBe('Переходим на bss.games…');
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

describe('localizeApiError', () => {
  const tRu = createTranslatorForLocale('ru');

  it('maps a known API error code to the localized message', () => {
    expect(localizeApiError(tRu, 'rate_limited')).toBe('Слишком много запросов. Попробуйте позже.');
    expect(localizeApiError(tRu, 'internal_error')).toBe('Внутренняя ошибка сервера.');
    expect(localizeApiError(tRu, 'invalid_period')).toBe('Некорректный период.');
  });

  it('falls back to the unknown message for an unmapped code', () => {
    expect(localizeApiError(tRu, 'teapot')).toBe('Произошла ошибка. Попробуйте ещё раз.');
    expect(localizeApiError(tRu, null)).toBe('Произошла ошибка. Попробуйте ещё раз.');
    expect(localizeApiError(tRu, undefined)).toBe('Произошла ошибка. Попробуйте ещё раз.');
  });

  it('does not treat the "unknown" sentinel as an API code path', () => {
    // A code literally named "unknown" still resolves via errors.unknown.
    expect(localizeApiError(tRu, 'unknown')).toBe('Произошла ошибка. Попробуйте ещё раз.');
  });
});

describe('extractApiErrorCode', () => {
  it('reads the code from a well-formed error envelope', () => {
    expect(extractApiErrorCode({ error: { code: 'rate_limited', message: 'x' } })).toBe(
      'rate_limited',
    );
  });

  it('returns null for malformed or missing envelopes', () => {
    expect(extractApiErrorCode(null)).toBeNull();
    expect(extractApiErrorCode('nope')).toBeNull();
    expect(extractApiErrorCode({})).toBeNull();
    expect(extractApiErrorCode({ error: null })).toBeNull();
    expect(extractApiErrorCode({ error: { message: 'x' } })).toBeNull();
    expect(extractApiErrorCode({ error: { code: 42 } })).toBeNull();
  });
});
