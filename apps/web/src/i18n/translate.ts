import type { Locale } from './config';
import { en } from './dictionaries/en';
import { ru, type TranslationKey } from './dictionaries/ru';

export type { TranslationKey } from './dictionaries/ru';

/** A locale dictionary: every translation key mapped to its localized string. */
export type Dictionary = Record<TranslationKey, string>;

/** Values interpolated into a translated string via `{token}` placeholders. */
export type TranslationParams = Record<string, string | number>;

/**
 * A bound translation function: resolves a {@link TranslationKey} to its
 * localized string, substituting any `{token}` placeholders from `params`.
 */
export type Translator = (key: TranslationKey, params?: TranslationParams) => string;

const DICTIONARIES: Record<Locale, Dictionary> = { en, ru };

/** Returns the dictionary for `locale`. */
export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}

/**
 * Replaces every `{token}` in `template` with the matching value from
 * `params`. Placeholders with no matching param are left untouched, so a
 * missing value is visible rather than silently dropped.
 */
export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = params[token];
    return value === undefined ? match : String(value);
  });
}

/**
 * Builds a {@link Translator} bound to `dictionary`. Unknown keys are not
 * reachable through the typed signature; if one is forced through at runtime
 * the key itself is returned so the miss surfaces instead of throwing.
 */
export function createTranslator(dictionary: Dictionary): Translator {
  return (key, params) => interpolate(dictionary[key] ?? key, params);
}

/** Convenience: a {@link Translator} for `locale`. */
export function createTranslatorForLocale(locale: Locale): Translator {
  return createTranslator(getDictionary(locale));
}
