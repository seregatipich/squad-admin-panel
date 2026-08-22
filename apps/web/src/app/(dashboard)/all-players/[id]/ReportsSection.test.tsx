// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReportsSection } from './ReportsSection';

const REPORTS_RESPONSE = {
  items: [
    {
      id: 'r1',
      status: 'pending',
      body: 'Cheating on the server',
      created_at: '2026-07-09T10:00:00.000Z',
    },
    { id: 'r2', status: 'resolved', body: 'Toxic chat', created_at: '2026-07-08T10:00:00.000Z' },
  ],
  total: 2,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReportsSection', () => {
  it('is a valid React component', () => {
    expect(ReportsSection).toBeDefined();
    expect(typeof ReportsSection).toBe('function');
  });

  it('renders loading then the report list from a mocked fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(REPORTS_RESPONSE), { status: 200 }))),
    );

    render(<ReportsSection playerId="player-1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Загрузка жалоб');

    await screen.findByText('Cheating on the server');
    expect(screen.getByText('Toxic chat')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Жалобы на игрока' })).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('hides entirely on 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })),
      ),
    );

    const { container } = render(<ReportsSection playerId="player-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
