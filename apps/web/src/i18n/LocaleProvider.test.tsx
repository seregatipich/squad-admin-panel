// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Locale } from './config';
import { LocaleProvider, useIntlLocale, useLocale, useTranslator } from './LocaleProvider';

function Probe() {
  const locale = useLocale();
  const intlLocale = useIntlLocale();
  const t = useTranslator();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="intl-locale">{intlLocale}</span>
      <span data-testid="date">{new Date(2026, 7, 22).toLocaleDateString(intlLocale)}</span>
      <span data-testid="text">{t('login.steamButton')}</span>
    </div>
  );
}

afterEach(cleanup);

describe('LocaleProvider', () => {
  it('exposes the ru locale, a day-first Intl tag and a bound Russian translator', () => {
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('locale')).toHaveTextContent('ru');
    expect(screen.getByTestId('intl-locale')).toHaveTextContent('ru-RU');
    expect(screen.getByTestId('date')).toHaveTextContent('22.08.2026');
    expect(screen.getByTestId('text')).toHaveTextContent('Войти через Steam');
  });

  it('ignores a locale prop and still resolves to ru', () => {
    render(
      // Cast: `Locale` now has a single value ('ru'). This proves the prop is
      // ignored, not that 'en' is still a real locale.
      <LocaleProvider locale={'en' as Locale}>
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('locale')).toHaveTextContent('ru');
    expect(screen.getByTestId('intl-locale')).toHaveTextContent('ru-RU');
    expect(screen.getByTestId('text')).toHaveTextContent('Войти через Steam');
  });

  it('falls back to the ru locale outside a provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('locale')).toHaveTextContent('ru');
    expect(screen.getByTestId('intl-locale')).toHaveTextContent('ru-RU');
    expect(screen.getByTestId('text')).toHaveTextContent('Войти через Steam');
  });
});
