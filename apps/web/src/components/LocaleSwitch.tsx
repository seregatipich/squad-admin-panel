'use client';

import { useRouter } from 'next/navigation';
import { LOCALE_COOKIE, LOCALES, type Locale } from '@/i18n/config';
import { useLocale, useTranslator } from '@/i18n/LocaleProvider';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Persists `locale` in the `locale` cookie and asks the router to re-render, so
 * Server Components (root layout `<html lang>`, any server-localized page) pick
 * the new dictionary up on the next render.
 */
function persistLocale(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}

/**
 * Language toggle. Renders one button per supported {@link Locale} and marks
 * the active one via `aria-pressed`, so it is usable and testable without a
 * pointer.
 */
export function LocaleSwitch({ className }: { className?: string }) {
  const router = useRouter();
  const active = useLocale();
  const t = useTranslator();

  return (
    <fieldset className={className} aria-label={t('localeSwitch.label')}>
      {LOCALES.map((locale) => {
        const isActive = locale === active;
        return (
          <button
            key={locale}
            type="button"
            aria-pressed={isActive}
            onClick={() => {
              if (isActive) return;
              persistLocale(locale);
              router.refresh();
            }}
            className={`px-2 py-0.5 text-xs uppercase transition-colors ${
              isActive
                ? 'font-semibold text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {t(locale === 'en' ? 'localeSwitch.en' : 'localeSwitch.ru')}
          </button>
        );
      })}
    </fieldset>
  );
}
