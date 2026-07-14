// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TagProtectionCard from './TagProtectionCard';

function mockFetch(patchResponse: () => Promise<Response>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/settings') && init?.method === 'PATCH') {
      return patchResponse();
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TagProtectionCard', () => {
  it('renders the current protection state', () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
    render(<TagProtectionCard clanId="clan-1" initialProtected={false} />);
    expect(screen.getByText('Защита тега')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Защита выключена' })).toBeInTheDocument();
  });

  it('toggles on click and PATCHes /api/v1/clans/:id/settings with is_tag_protected', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() =>
        Promise.resolve(new Response(JSON.stringify({ is_tag_protected: true }), { status: 200 })),
      ),
    );
    const user = userEvent.setup();
    render(<TagProtectionCard clanId="clan-1" initialProtected={false} />);
    await user.click(screen.getByRole('button', { name: 'Защита выключена' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/clans/clan-1/settings',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ is_tag_protected: true }),
        }),
      );
    });
    expect(await screen.findByRole('button', { name: 'Защита включена' })).toBeInTheDocument();
  });

  it('hides the interactive toggle and falls back to a status badge on 403', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(() => Promise.resolve(new Response('{"error":"forbidden"}', { status: 403 }))),
    );
    const user = userEvent.setup();
    render(<TagProtectionCard clanId="clan-1" initialProtected={false} />);
    await user.click(screen.getByRole('button', { name: 'Защита выключена' }));

    await waitFor(() => {
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Защита выключена')).toBeInTheDocument();
  });
});
