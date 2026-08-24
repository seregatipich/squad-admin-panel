/**
 * Locale configuration for the panel's UI i18n layer.
 *
 * The panel ships Russian-first (matching the historical hard-coded UI), so
 * {@link DEFAULT_LOCALE} is `ru` and the Russian dictionary is the source of
 * truth for the translation-key set. English is a full translation of it.
 */

/** Locales the panel UI is translated into. */
export const LOCALES = ['en', 'ru'] as const;

/** A supported UI locale. */
export type Locale = (typeof LOCALES)[number];

/** Locale used when no valid preference is present (Russian-first panel). */
export const DEFAULT_LOCALE: Locale = 'ru';

/**
 * Cookie carrying the viewer's locale preference. Read on the server (root
 * layout) to pick the dictionary and set `<html lang>`, and written on the
 * client by {@link LocaleSwitch}. Not `__Host-`/`__Secure-`-prefixed: it is a
 * non-sensitive preference that must survive plain-HTTP local development.
 */
export const LOCALE_COOKIE = 'locale';

/** Type guard: whether `value` is one of the supported {@link LOCALES}. */
export function isLocale(value: string | null | undefined): value is Locale {
  return value != null && (LOCALES as readonly string[]).includes(value);
}

/**
 * Resolves an arbitrary cookie/header value to a supported {@link Locale},
 * falling back to {@link DEFAULT_LOCALE} for anything unrecognised.
 */
export function resolveLocale(value: string | null | undefined): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * BCP-47 tags used for `Intl` formatting of dates, times and numbers.
 *
 * Kept apart from {@link LOCALES} because a UI-dictionary key and a formatting
 * locale are different things: `en` alone resolves to US conventions
 * (`8/23/2026, 11:35:00 AM`), which mixes a 12-hour clock and a month-first
 * order into a panel whose every other timestamp is day-first and 24-hour.
 * `en-GB` keeps English month names where they appear while matching the
 * Russian field order, so the two locales stay comparable at a glance.
 */
export const INTL_LOCALE: Record<Locale, string> = {
  en: 'en-GB',
  ru: 'ru-RU',
};
