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

const NO_ROLE_RU = 'У вас нет доступа к панели';
const ROLE_NO_ACCESS_RU = 'Ваша роль не имеет доступа к панели';

function renderNoAccess(locale: 'ru' | 'en' = 'ru') {
  render(
    <LocaleProvider locale={locale}>
      <NoAccessPage />
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  searchParams.value = '';
});

describe('NoAccessPage', () => {
  it('shows the no-role message (RU) when reason=no_role', () => {
    searchParams.value = 'steam_id64=76561198000000200&reason=no_role';
    renderNoAccess('ru');
    expect(screen.getByText(NO_ROLE_RU)).toBeInTheDocument();
    expect(screen.queryByText(ROLE_NO_ACCESS_RU)).not.toBeInTheDocument();
    expect(screen.getByText('76561198000000200')).toBeInTheDocument();
  });

  it('shows the role-without-access message (RU) when reason=role_no_access', () => {
    searchParams.value = 'steam_id64=76561198000000201&reason=role_no_access';
    renderNoAccess('ru');
    expect(screen.getByText(ROLE_NO_ACCESS_RU)).toBeInTheDocument();
    expect(screen.queryByText(NO_ROLE_RU)).not.toBeInTheDocument();
    expect(screen.getByText('76561198000000201')).toBeInTheDocument();
  });

  it('falls back to the no-role message when reason is absent', () => {
    renderNoAccess('ru');
    expect(screen.getByText(NO_ROLE_RU)).toBeInTheDocument();
    expect(screen.queryByText(ROLE_NO_ACCESS_RU)).not.toBeInTheDocument();
  });

  it('renders the access-denied heading and back link in Russian', () => {
    renderNoAccess('ru');
    expect(screen.getByRole('heading', { name: 'Доступ запрещён' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Вернуться на страницу входа' })).toBeInTheDocument();
  });

  it('renders the access-denied copy in English', () => {
    renderNoAccess('en');
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(screen.getByText('You do not have access to the panel')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the sign-in page' })).toBeInTheDocument();
  });
});
