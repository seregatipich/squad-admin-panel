'use client';

import { createContext, useContext, useMemo } from 'react';
import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from './config';
import { createTranslatorForLocale, type Translator } from './translate';

interface LocaleContextValue {
  locale: Locale;
  t: Translator;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * Provides the active {@link Locale} and a bound {@link Translator} to client
 * components. Fed by the root layout, which resolves the locale on the server
 * from the `locale` cookie so the first render already matches `<html lang>`.
 */
export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const value = useMemo<LocaleContextValue>(
    () => ({ locale, t: createTranslatorForLocale(locale) }),
    [locale],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

function useLocaleContext(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (ctx === null) {
    // Fall back to the default locale rather than throwing: a stray component
    // rendered outside the provider still shows readable (default-locale) text.
    return { locale: DEFAULT_LOCALE, t: createTranslatorForLocale(DEFAULT_LOCALE) };
  }
  return ctx;
}

/** The active UI locale. */
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
