// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The sidebar fetches a pending-reports count on mount; keep it inert.
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve(new Response(JSON.stringify({ total: 0 }), { status: 200 }))),
);

import { SidebarNav } from './SidebarNav';

afterEach(cleanup);

describe('SidebarNav', () => {
  it('exports a React component function', () => {
    expect(typeof SidebarNav).toBe('function');
  });

  it('lists /vips under the "Управление" group, gated on user:view', async () => {
    const { NAV_GROUPS } = await import('@/lib/nav');
    const managementGroup = NAV_GROUPS.find((g) => g.label === 'Управление');
    const vipsItem = managementGroup?.items.find((item) => item.href === '/vips');
    expect(vipsItem).toEqual({
      href: '/vips',
      label: 'VIP',
      labelKey: 'nav.vips',
      permission: 'user:view',
    });
  });

  it('renders navigation labels in Russian', () => {
    render(
      <LocaleProvider locale="ru">
        <SidebarNav permissions={['user:view']} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('link', { name: 'Дашборд' })).toBeInTheDocument();
    expect(screen.getByText('Управление')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
  });

  it('renders the same navigation in English', () => {
    render(
      <LocaleProvider locale="en">
        <SidebarNav permissions={['user:view']} displayName="Alice" />
      </LocaleProvider>,
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Management')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.queryByText('Дашборд')).not.toBeInTheDocument();
  });
});
