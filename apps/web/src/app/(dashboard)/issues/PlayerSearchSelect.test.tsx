// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlayerSearchSelect } from './PlayerSearchSelect';

function stubFetch(items: Array<{ id: string; canonical_name: string }>) {
  return vi.fn((_input: RequestInfo | URL) =>
    Promise.resolve(new Response(JSON.stringify({ items, total: items.length }), { status: 200 })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PlayerSearchSelect', () => {
  it('queries the lightweight /api/v1/players/search endpoint, not the full list', async () => {
    const fetchMock = stubFetch([{ id: 'p1', canonical_name: 'Игрок' }]);
    vi.stubGlobal('fetch', fetchMock);
    render(<PlayerSearchSelect placeholder="Поиск игрока" onSelect={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('Поиск игрока'), { target: { value: 'иг' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toMatch(/^\/api\/v1\/players\/search\?/);
  });

  it('clears the loading and open state once the query shrinks below two characters', async () => {
    const fetchMock = stubFetch([{ id: 'p1', canonical_name: 'Игрок' }]);
    vi.stubGlobal('fetch', fetchMock);
    render(<PlayerSearchSelect placeholder="Поиск игрока" onSelect={() => {}} />);

    const input = screen.getByPlaceholderText('Поиск игрока');
    fireEvent.change(input, { target: { value: 'иг' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await screen.findByRole('option', { name: 'Игрок' });

    fireEvent.change(input, { target: { value: 'и' } });

    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByText('Поиск игроков')).not.toBeInTheDocument();
  });
});
