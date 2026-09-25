// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountIdentity } from './AccountIdentity';
import type { AccountNames } from './helpers';

const NAMES: AccountNames = {
  canonical_name: 'Bravo',
  persona_name: 'SteamNick',
  history: [
    {
      name: 'Bravo',
      first_seen_at: '2026-06-01T00:00:00.000Z',
      last_seen_at: '2026-08-01T00:00:00.000Z',
    },
    {
      name: 'Charlie',
      first_seen_at: '2026-03-01T00:00:00.000Z',
      last_seen_at: '2026-06-01T00:00:00.000Z',
    },
    {
      name: 'Alpha',
      first_seen_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: '2026-03-01T00:00:00.000Z',
    },
  ],
};

afterEach(cleanup);

describe('AccountIdentity', () => {
  it('shows the in-game name', () => {
    render(<AccountIdentity names={NAMES} />);
    expect(screen.getByText('Bravo')).toBeInTheDocument();
  });

  it('renders nothing while the names are still loading', () => {
    const { container } = render(<AccountIdentity names={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts only the names that are not already on display', () => {
    render(<AccountIdentity names={NAMES} />);
    expect(screen.getByRole('button', { name: 'ещё 2 ника' })).toBeInTheDocument();
  });

  it('offers no history button when there is nothing but the current name', () => {
    render(
      <AccountIdentity
        names={{
          canonical_name: 'Bravo',
          persona_name: null,
          history: [
            {
              name: 'Bravo',
              first_seen_at: '2026-06-01T00:00:00.000Z',
              last_seen_at: '2026-08-01T00:00:00.000Z',
            },
          ],
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: /ещё/ })).not.toBeInTheDocument();
  });

  it('opens the history with each past name and the days it was seen', () => {
    render(<AccountIdentity names={NAMES} />);
    fireEvent.click(screen.getByRole('button', { name: 'ещё 2 ника' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('История ников')).toBeInTheDocument();
    expect(within(dialog).getByText('Charlie')).toBeInTheDocument();
    expect(within(dialog).getByText('Alpha')).toBeInTheDocument();
    // Ник из шапки в списке не повторяется.
    expect(within(dialog).queryByText('Bravo')).not.toBeInTheDocument();
    expect(within(dialog).getByText('01.03.2026 — 01.06.2026')).toBeInTheDocument();
  });
});
