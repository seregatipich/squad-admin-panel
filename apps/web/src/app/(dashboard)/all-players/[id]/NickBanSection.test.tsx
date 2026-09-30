// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NickBanSection } from './NickBanSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function checkResponse(
  overrides: Partial<{ matched: boolean; rule: unknown; can_mutate: boolean }>,
) {
  return {
    matched: false,
    rule: null,
    can_mutate: true,
    ...overrides,
  };
}

describe('NickBanSection', () => {
  it('renders nothing on a 401 check response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))),
    );
    const { container } = render(<NickBanSection nick="Someone" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows «Забанить ник» when unmatched and can_mutate=true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(checkResponse({})), { status: 200 })),
      ),
    );
    render(<NickBanSection nick="CleanNick" />);
    expect(await screen.findByRole('button', { name: /забанить ник/i })).toBeInTheDocument();
  });

  it('hides the ban button when can_mutate=false and nothing matched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(checkResponse({ can_mutate: false })), { status: 200 }),
        ),
      ),
    );
    render(<NickBanSection nick="CleanNick" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /забанить ник/i })).not.toBeInTheDocument();
  });

  it('shows the «Ник забанен» badge with a rule link when matched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              checkResponse({
                matched: true,
                rule: {
                  id: 'rule-1',
                  pattern: 'BadNick',
                  match_type: 'exact',
                  action: 'kick',
                  reason: null,
                  is_active: true,
                },
              }),
            ),
            { status: 200 },
          ),
        ),
      ),
    );
    render(<NickBanSection nick="BadNick" />);
    expect(await screen.findByText(/ник забанен/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /правило/i });
    expect(link).toHaveAttribute('href', '/banned-names?rule=rule-1');
    expect(screen.getByRole('button', { name: /разбанить ник/i })).toBeInTheDocument();
  });

  it('«Разбанить ник» asks for confirmation, PATCHes is_active:false and the badge disappears', async () => {
    let matched = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/v1/banned-names/check')) {
          return Promise.resolve(
            new Response(
              JSON.stringify(
                checkResponse(
                  matched
                    ? {
                        matched: true,
                        rule: {
                          id: 'rule-1',
                          pattern: 'BadNick',
                          match_type: 'exact',
                          action: 'kick',
                          reason: null,
                          is_active: true,
                        },
                      }
                    : {},
                ),
              ),
              { status: 200 },
            ),
          );
        }
        if (url === '/api/v1/banned-names/rule-1' && init?.method === 'PATCH') {
          matched = false;
          return Promise.resolve(new Response(JSON.stringify({ id: 'rule-1' }), { status: 200 }));
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    render(<NickBanSection nick="BadNick" />);
    expect(await screen.findByText(/ник забанен/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /разбанить ник/i }));

    const dialog = await screen.findByRole('dialog', { name: 'Разбанить ник' });
    expect(dialog).toHaveTextContent('правило «BadNick» будет отключено');
    fireEvent.click(within(dialog).getByRole('button', { name: /разбанить ник/i }));

    await waitFor(() => expect(screen.queryByText(/ник забанен/i)).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: /забанить ник/i })).toBeInTheDocument();
  });

  it('re-checks when refreshKey changes', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(checkResponse({})), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<NickBanSection nick="CleanNick" refreshKey={0} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<NickBanSection nick="CleanNick" refreshKey={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  // Regression (#450): any failure (500, timeout, network) used to hide the
  // block for good, and a later re-check could never bring it back.
  it('keeps the block with a retry when the check fails for a reason other than auth', async () => {
    let failing = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          failing
            ? new Response(null, { status: 500 })
            : new Response(JSON.stringify(checkResponse({})), { status: 200 }),
        ),
      ),
    );
    render(<NickBanSection nick="CleanNick" />);

    expect(await screen.findByText('Не удалось проверить ник')).toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByRole('button', { name: /забанить ник/i })).toBeInTheDocument();
    expect(screen.queryByText('Не удалось проверить ник')).not.toBeInTheDocument();
  });

  it('drops a stale check that answers after a newer one', async () => {
    const matchedBody = checkResponse({
      matched: true,
      rule: {
        id: 'rule-1',
        pattern: 'CleanNick',
        match_type: 'exact',
        action: 'kick',
        reason: null,
        is_active: true,
      },
    });
    let releaseFirst: (response: Response) => void = () => {};
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return Promise.resolve(new Response(JSON.stringify(checkResponse({})), { status: 200 }));
      }),
    );
    const { rerender } = render(<NickBanSection nick="CleanNick" refreshKey={0} />);
    rerender(<NickBanSection nick="CleanNick" refreshKey={1} />);
    expect(await screen.findByRole('button', { name: /забанить ник/i })).toBeInTheDocument();

    await act(async () => {
      releaseFirst(new Response(JSON.stringify(matchedBody), { status: 200 }));
    });

    expect(screen.queryByText(/ник забанен/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /забанить ник/i })).toBeInTheDocument();
  });
});
