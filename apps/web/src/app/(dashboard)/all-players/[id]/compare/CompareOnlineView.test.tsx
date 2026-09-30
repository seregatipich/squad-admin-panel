// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompareOnlineView } from './CompareOnlineView';

const PLAYER_A = 'a1e2c3d4-0000-0000-0000-00000000000a';
const PLAYER_B = 'b1e2c3d4-0000-0000-0000-00000000000b';
const PLAYER_C = 'c1e2c3d4-0000-0000-0000-00000000000c';

function compareBody(otherId: string, otherName: string) {
  return {
    window: { from: '2026-06-29', to: '2026-07-05' },
    players: [
      { id: PLAYER_A, canonical_name: 'PlayerA', steam_id64: null },
      { id: otherId, canonical_name: otherName, steam_id64: null },
    ],
    sessions: { a: [], b: [] },
    overlap: { total_seconds: 0, concurrent_count: 0, intervals: [] },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CompareOnlineView', () => {
  // Regression (#471): «Повторить» dropped load()'s cancel function, so its
  // late answer for the previous player overwrote the newly selected one.
  it('never lets a retried request for the previous player overwrite the current one', async () => {
    let releaseRetry: (response: Response) => void = () => {};
    let compareCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/v1/players?q=')) {
          return Promise.resolve(json({ items: [{ id: PLAYER_C, canonical_name: 'PlayerC' }] }));
        }
        compareCalls += 1;
        if (url.includes(`other=${PLAYER_C}`)) {
          return Promise.resolve(json(compareBody(PLAYER_C, 'PlayerC')));
        }
        if (compareCalls === 1) return Promise.resolve(json({ error: 'boom' }, 500));
        return new Promise<Response>((resolve) => {
          releaseRetry = resolve;
        });
      }),
    );

    render(<CompareOnlineView playerId={PLAYER_A} initialOther={PLAYER_B} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Pla' } });
    fireEvent.click(await screen.findByRole('option', { name: 'PlayerC' }, { timeout: 3000 }));
    await screen.findByText(/Игрок B \(PlayerC\)/);

    await act(async () => {
      releaseRetry(json(compareBody(PLAYER_B, 'PlayerB')));
    });

    expect(screen.getByText(/Игрок B \(PlayerC\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Игрок B \(PlayerB\)/)).not.toBeInTheDocument();
  }, 15_000);

  it('reports a response that is not about the selected player instead of drawing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(compareBody(PLAYER_C, 'PlayerC')))),
    );

    render(<CompareOnlineView playerId={PLAYER_A} initialOther={PLAYER_B} />);

    await screen.findByText('Не удалось сравнить онлайн');
    expect(screen.queryByText(/Игрок B \(PlayerC\)/)).not.toBeInTheDocument();
  });

  it('reports a malformed body instead of crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({ players: [] }))),
    );

    render(<CompareOnlineView playerId={PLAYER_A} initialOther={PLAYER_B} />);

    await screen.findByText('Не удалось сравнить онлайн');
  });

  it('retries through the effect and renders the answer', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        return Promise.resolve(
          calls === 1 ? json({ error: 'boom' }, 500) : json(compareBody(PLAYER_B, 'PlayerB')),
        );
      }),
    );

    render(<CompareOnlineView playerId={PLAYER_A} initialOther={PLAYER_B} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }));

    await screen.findByText(/Игрок B \(PlayerB\)/);
  });
});
