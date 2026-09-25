// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useParams = vi.fn(() => ({ token: 'tracking-token-abcdef123456' }) as Record<string, string>);

vi.mock('next/navigation', () => ({ useParams: () => useParams() }));

import AppealStatusPage from './page';

const TEST_TIMEOUT_MS = 15_000;

function mockFetch(status: number, payload: Record<string, unknown>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/public/appeals/')) {
      return Promise.resolve(new Response(JSON.stringify(payload), { status }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppealStatusPage', () => {
  it(
    'renders a pending appeal without any decision',
    async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch(200, {
          number: 12,
          status: 'pending',
          created_at: '2026-07-20T10:00:00.000Z',
          decided_at: null,
          decision_note: null,
        }),
      );
      render(<AppealStatusPage />);

      expect(await screen.findByText('#12')).toBeInTheDocument();
      expect(screen.getByText(/на рассмотрении/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders the decision note once the appeal is approved',
    async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch(200, {
          number: 13,
          status: 'approved',
          created_at: '2026-07-20T10:00:00.000Z',
          decided_at: '2026-07-21T10:00:00.000Z',
          decision_note: 'бан снят, извините за неудобства',
        }),
      );
      render(<AppealStatusPage />);

      expect(await screen.findByText(/бан снят, извините за неудобства/)).toBeInTheDocument();
      expect(screen.getByText(/одобрена/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders a not-found message for an unknown token',
    async () => {
      vi.stubGlobal('fetch', mockFetch(404, { error: 'appeal_not_found' }));
      render(<AppealStatusPage />);

      expect(await screen.findByText(/апелляция не найдена/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders an error message when the request throws',
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(new Error('offline'))),
      );
      render(<AppealStatusPage />);

      expect(await screen.findByText(/не удалось загрузить/i)).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders a not-found message when the route has no token',
    async () => {
      useParams.mockReturnValueOnce({});
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(new Error('should not be called'))),
      );
      render(<AppealStatusPage />);

      await waitFor(() => expect(screen.getByText(/апелляция не найдена/i)).toBeInTheDocument());
    },
    TEST_TIMEOUT_MS,
  );
});
