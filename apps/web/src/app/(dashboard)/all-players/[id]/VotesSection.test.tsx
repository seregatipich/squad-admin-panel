// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VotesSection } from './VotesSection';

function stub(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('VotesSection', () => {
  it('renders the vote counters', async () => {
    stub({
      player_id: 'p-1',
      initiated: 3,
      participated: 10,
      serial_skipper: { flagged: false, skip_count: 1, threshold: 5, window_days: 7 },
    });
    render(<VotesSection playerId="player-1" />);

    expect(await screen.findByText('Инициировал')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  // Regression (#468): 401/403 showed a red «HTTP 403» banner, unlike every
  // sibling section, which hides for a viewer without access.
  it.each([401, 403])('hides entirely on %i', async (status) => {
    stub({ error: 'forbidden' }, status);
    const { container } = render(<VotesSection playerId="player-1" />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  // Regression (#468): an unvalidated body crashed the whole player card.
  it('reports a malformed body instead of crashing', async () => {
    stub({ error: 'boom' });
    render(<VotesSection playerId="player-1" />);

    expect(await screen.findByText('Не удалось загрузить голосования')).toBeInTheDocument();
  });
});
