// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: () => ({ value: 'x' }), has: () => true }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/vips'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/lib/dal', () => ({
  requireSession: vi.fn().mockResolvedValue({
    steam_id64: '1',
    canonical_name: 'T',
    permissions: ['user:view'],
  }),
  SESSION_COOKIE: '__Host-sid',
}));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn().mockResolvedValue([]) }));

import VipsPage from './page';

afterEach(cleanup);

describe('VipsPage', () => {
  it('is a valid React component', () => {
    expect(VipsPage).toBeDefined();
    expect(typeof VipsPage).toBe('function');
  });

  it('renders the roster table for a permitted user with no assignments', async () => {
    const element = await VipsPage({ searchParams: Promise.resolve({}) });
    expect(element).toBeDefined();
  });

  it('gives the page exactly one heading and an "nothing granted yet" empty state', async () => {
    render(await VipsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'VIP-роли' })).toBeInTheDocument();
    const empty = screen.getByText('Ролей никому не выдано');
    expect(empty.closest('[data-variant]')).toHaveAttribute('data-variant', 'initial');
  });

  it('distinguishes an empty filter result and offers a reset link', async () => {
    render(await VipsPage({ searchParams: Promise.resolve({ expiring_soon: 'true' }) }));

    const empty = screen.getByText('Ничего не нашлось');
    expect(empty.closest('[data-variant]')).toHaveAttribute('data-variant', 'filtered');
    for (const reset of screen.getAllByRole('link', { name: 'Сбросить фильтр' })) {
      expect(reset).toHaveAttribute('href', '/vips');
    }
  });

  it('keeps the filter form usable without client JS', async () => {
    render(await VipsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByLabelText('Роль')).toHaveAttribute('name', 'role_id');
    expect(screen.getByLabelText('Истекают скоро')).toHaveAttribute('name', 'expiring_soon');
    expect(screen.getByRole('button', { name: 'Применить' })).toHaveAttribute('type', 'submit');
  });
});
