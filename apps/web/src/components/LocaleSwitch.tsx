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
    <fieldset
      className={`inline-flex items-center gap-0.5${className ? ` ${className}` : ''}`}
      aria-label={t('localeSwitch.label')}
    >
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
            className={`h-7 rounded-ctl px-2 text-2xs uppercase transition-colors duration-150 ${
              isActive
                ? 'bg-raised font-semibold text-ink'
                : 'text-ink-3 hover:bg-raised hover:text-ink'
            }`}
          >
            {t(locale === 'en' ? 'localeSwitch.en' : 'localeSwitch.ru')}
          </button>
        );
      })}
    </fieldset>
  );
}
