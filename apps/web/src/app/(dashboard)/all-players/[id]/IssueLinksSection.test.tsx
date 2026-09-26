// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IssueLinksSection } from './IssueLinksSection';

const TEST_TIMEOUT_MS = 15_000;

function stubFetch(status: number, body?: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response(body !== undefined ? JSON.stringify(body) : null, { status })),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('IssueLinksSection', () => {
  it(
    'renders the open counter and the linked tickets',
    async () => {
      stubFetch(200, {
        open_count: 2,
        items: [
          { id: 'i-1', number: 42, title: 'Разобраться с жалобой', state: 'open' },
          { id: 'i-2', number: 41, title: 'Проверить бан', state: 'in_progress' },
        ],
      });
      render(<IssueLinksSection playerId="player-alpha" />);

      await screen.findByText('Связанные тикеты');
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Разобраться с жалобой/ })).toHaveAttribute(
        'href',
        '/issues/i-1',
      );
      expect(screen.getByText('#42')).toBeInTheDocument();
      expect(screen.getByText('В работе')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the player has no linked tickets',
    async () => {
      stubFetch(200, { open_count: 0, items: [] });
      const { container } = render(<IssueLinksSection playerId="player-alpha" />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the API responds with 403',
    async () => {
      stubFetch(403);
      const { container } = render(<IssueLinksSection playerId="player-alpha" />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'renders nothing when the API responds with 401',
    async () => {
      stubFetch(401);
      const { container } = render(<IssueLinksSection playerId="player-alpha" />);

      await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shows an error state on a 500 response',
    async () => {
      stubFetch(500);
      render(<IssueLinksSection playerId="player-alpha" />);

      await screen.findByText('Не удалось загрузить связанные тикеты');
      expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS,
  );
});
