/**
 * Locale configuration for the panel's UI i18n layer.
 *
 * The panel is Russian-only. The Russian dictionary is the sole dictionary
 * and the source of truth for the translation-key set.
 */

/** Locales the panel UI is translated into. */
export const LOCALES = ['ru'] as const;

/** A supported UI locale. */
export type Locale = (typeof LOCALES)[number];

/** The only supported locale. */
export const DEFAULT_LOCALE: Locale = 'ru';

/**
 * BCP-47 tag used for `Intl` formatting of dates, times and numbers.
 *
 * Kept apart from {@link LOCALES} because a UI-dictionary key and a
 * formatting locale are different things: a bare `toLocaleString()` renders
 * in the *browser's* locale, so the same timestamp comes out
 * `8/23/2026, 11:35:00 AM` on one machine and `23.08.2026, 11:35:00` on the
 * next, regardless of the panel's own (fixed) language.
 */
export const INTL_LOCALE: Record<Locale, string> = {
  ru: 'ru-RU',
};
