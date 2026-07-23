// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LocaleProvider, useLocale, useTranslator } from './LocaleProvider';

function Probe() {
  const locale = useLocale();
  const t = useTranslator();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
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

  it('falls back to the default (ru) locale outside a provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('locale')).toHaveTextContent('ru');
    expect(screen.getByTestId('text')).toHaveTextContent('Войти через Steam');
  });
});
