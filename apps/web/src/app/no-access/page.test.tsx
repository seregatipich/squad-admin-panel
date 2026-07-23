// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';

const searchParams = { value: '' };

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParams.value),
}));

import NoAccessPage from './page';

afterEach(() => {
  cleanup();
  searchParams.value = '';
});

describe('NoAccessPage', () => {
  it('renders the access-denied copy in Russian', () => {
    searchParams.value = '';
    render(
      <LocaleProvider locale="ru">
        <NoAccessPage />
      </LocaleProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Доступ запрещён' })).toBeInTheDocument();
    expect(screen.getByText('Ваш Steam-аккаунт не имеет роли в этой панели.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Вернуться на страницу входа' })).toBeInTheDocument();
  });

  it('renders the access-denied copy in English', () => {
    searchParams.value = '';
    render(
      <LocaleProvider locale="en">
        <NoAccessPage />
      </LocaleProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(
      screen.getByText('Your Steam account does not have a role in this panel.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the sign-in page' })).toBeInTheDocument();
  });

  it('interpolates the Steam ID when present', () => {
    searchParams.value = 'steam_id64=76561198000000002';
    render(
      <LocaleProvider locale="en">
        <NoAccessPage />
      </LocaleProvider>,
    );
    expect(
      screen.getByText('Steam ID 76561198000000002 does not have a role in this panel.'),
    ).toBeInTheDocument();
  });
});
