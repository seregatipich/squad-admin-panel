'use client';

import { createContext, useContext } from 'react';
import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from './config';
import { createTranslatorForLocale, type Translator } from './translate';

interface LocaleContextValue {
  locale: Locale;
  t: Translator;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

const RU_VALUE: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  t: createTranslatorForLocale(DEFAULT_LOCALE),
};

/**
 * Provides the (Russian-only) {@link Locale} and its bound {@link Translator}
 * to client components. The panel no longer offers a language switch, so the
 * `locale` prop is accepted for source compatibility with existing call sites
 * but is otherwise ignored — every render resolves to {@link DEFAULT_LOCALE}.
 */
export function LocaleProvider({ children }: { locale?: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={RU_VALUE}>{children}</LocaleContext.Provider>;
}

function useLocaleContext(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (ctx === null) {
    // Fall back to the default locale rather than throwing: a stray component
    // rendered outside the provider still shows readable (default-locale) text.
    return RU_VALUE;
  }
  return ctx;
}

/** The active UI locale (always {@link DEFAULT_LOCALE}). */
export function useLocale(): Locale {
  return useLocaleContext().locale;
}

/** The bound {@link Translator} for the active locale. */
export function useTranslator(): Translator {
  return useLocaleContext().t;
}

/**
 * The active locale as a BCP-47 tag for `Intl` — what {@link DateTime},
 * {@link formatAbsolute} and `toLocaleString` want.
 *
 * Exists so no call site has to reach for a literal: a bare `toLocaleString()`
 * renders in the *browser's* locale, so the same timestamp comes out
 * `8/23/2026, 11:35:00 AM` on one machine and `23.08.2026, 11:35:00` on the
 * next, and the panel's own language does not enter into it at all.
 */
export function useIntlLocale(): string {
  return INTL_LOCALE[useLocaleContext().locale];
}
