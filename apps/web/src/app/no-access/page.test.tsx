// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const searchParams = { current: new URLSearchParams() };

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams.current,
}));

import NoAccessPage from './page';

const NO_ROLE_MESSAGE = 'У вас нет доступа к панели';
const ROLE_NO_ACCESS_MESSAGE = 'Ваша роль не имеет доступа к панели';

afterEach(() => {
  cleanup();
  searchParams.current = new URLSearchParams();
});

describe('NoAccessPage', () => {
  it('renders the no-role message when reason=no_role', () => {
    searchParams.current = new URLSearchParams({
      steam_id64: '76561198000000200',
      reason: 'no_role',
    });
    render(<NoAccessPage />);
    expect(screen.getByText(NO_ROLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(ROLE_NO_ACCESS_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByText('76561198000000200')).toBeInTheDocument();
  });

  it('renders the role-without-access message when reason=role_no_access', () => {
    searchParams.current = new URLSearchParams({
      steam_id64: '76561198000000201',
      reason: 'role_no_access',
    });
    render(<NoAccessPage />);
    expect(screen.getByText(ROLE_NO_ACCESS_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(NO_ROLE_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByText('76561198000000201')).toBeInTheDocument();
  });

  it('falls back to the no-role message when reason is absent', () => {
    render(<NoAccessPage />);
    expect(screen.getByText(NO_ROLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(ROLE_NO_ACCESS_MESSAGE)).not.toBeInTheDocument();
  });
});
