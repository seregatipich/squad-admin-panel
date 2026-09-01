// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/dal', () => ({
  requireSession: vi.fn().mockResolvedValue({ canonical_name: 'Patrego' }),
}));
vi.mock('@/lib/bss-site', () => ({ getBssSiteUrl: () => 'https://bss.games' }));
vi.mock('@/components/LogoutButton', () => ({
  LogoutButton: () => <button type="button">Выйти</button>,
  GlobalLogoutButton: () => <button type="button">Выйти везде</button>,
}));

import MeLayout from './layout';

afterEach(cleanup);

describe('MeLayout', () => {
  it('exposes the site and both logout scopes to a self-service user', async () => {
    render(await MeLayout({ children: null }));

    expect(screen.getByRole('link', { name: 'Перейти на bss.games' })).toHaveAttribute(
      'href',
      'https://bss.games',
    );
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выйти везде' })).toBeInTheDocument();
  });
});
