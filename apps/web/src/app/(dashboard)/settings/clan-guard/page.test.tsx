// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/settings/clan-guard'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import ClanGuardSettingsPage from './page';

function mockFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/settings/clan-guard')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ enabled: true, grace_period_seconds: 300, updated_at: null }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith('/api/v1/me')) {
      return Promise.resolve(
        new Response(JSON.stringify({ can_manage_clans: true }), { status: 200 }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ClanGuardSettingsPage', () => {
  it('is a valid React component', () => {
    expect(ClanGuardSettingsPage).toBeDefined();
    expect(typeof ClanGuardSettingsPage).toBe('function');
  });

  it('loads settings and renders the kill-switch and grace-period field', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<ClanGuardSettingsPage />);
    expect(await screen.findByText('Защита клан-тегов')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Механизм защиты клан-тегов')).toBeChecked();
    });
    expect(screen.getByDisplayValue('300')).toBeInTheDocument();
  });
});
