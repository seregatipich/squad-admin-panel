// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatCooldown, SeedCallButton } from './SeedCallButton';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('formatCooldown', () => {
  it('formats seconds as minutes and seconds', () => {
    expect(formatCooldown(125)).toBe('2:05');
  });
});

describe('SeedCallButton', () => {
  it('hides the button without chat or manageserver permission', () => {
    render(<SeedCallButton serverId="server-1" canCall={false} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('posts a manual seed call and starts the cooldown', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ retry_after: 7200 }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ available: true, retry_after: 0, join_link: null }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SeedCallButton serverId="server-1" canCall />);
    const button = await screen.findByRole('button', { name: 'Позвать сидеров' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Сидеры уведомлены')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/servers/server-1/seed-call',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByRole('button', { name: /Повторить через 120:00/ })).toBeDisabled();
  });
});
