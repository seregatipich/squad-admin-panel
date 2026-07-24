// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

import { LocaleSwitch } from './LocaleSwitch';

beforeEach(() => {
  refresh.mockClear();
  document.cookie = 'locale=; path=/; max-age=0';
});

afterEach(cleanup);

describe('LocaleSwitch', () => {
  it('marks the active locale as pressed', () => {
    render(
      <LocaleProvider locale="ru">
        <LocaleSwitch />
      </LocaleProvider>,
    );
    expect(screen.getByRole('button', { name: 'Русский' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('persists the chosen locale to the cookie and refreshes the router', () => {
    render(
      <LocaleProvider locale="ru">
        <LocaleSwitch />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(document.cookie).toContain('locale=en');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does nothing when the active locale is clicked again', () => {
    render(
      <LocaleProvider locale="en">
        <LocaleSwitch />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(refresh).not.toHaveBeenCalled();
  });
});
