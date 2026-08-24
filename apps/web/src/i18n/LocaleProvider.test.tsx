// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
  it('exposes the provided locale and a bound translator', () => {
    render(
      <LocaleProvider locale="en">
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('locale')).toHaveTextContent('en');
    expect(screen.getByTestId('text')).toHaveTextContent('Sign in with Steam');
  });

  /* Регрессия: панель печатала даты в локали браузера, из-за чего в русском
     интерфейсе соседствовали «8/23/2026, 11:35:00 AM» и «22.08.2026, 03:33». */
  it('gives Intl a day-first tag for both locales, never the US default', () => {
    render(
      <LocaleProvider locale="ru">
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('intl-locale')).toHaveTextContent('ru-RU');
    expect(screen.getByTestId('date')).toHaveTextContent('22.08.2026');
    cleanup();

    render(
      <LocaleProvider locale="en">
        <Probe />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('intl-locale')).toHaveTextContent('en-GB');
    expect(screen.getByTestId('date')).toHaveTextContent('22/08/2026');
  });

  it('falls back to the default (ru) locale outside a provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('locale')).toHaveTextContent('ru');
    expect(screen.getByTestId('intl-locale')).toHaveTextContent('ru-RU');
    expect(screen.getByTestId('text')).toHaveTextContent('Войти через Steam');
  });
});
