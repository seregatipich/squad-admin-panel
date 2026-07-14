// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { matchBannedName, validateBannedNamePattern } from '@squad/shared-config/banned-names';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/banned-names'),
  useSearchParams: vi.fn(() => mockSearchParams),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import BannedNamesPage from './page';

const RULE = {
  id: 'rule-1',
  pattern: 'AdolfHitler',
  match_type: 'exact',
  reason: null,
  action: 'kick',
  is_active: true,
  author_name: 'Owner',
  created_at: new Date().toISOString(),
  hit_count: 3,
  last_hit_at: new Date().toISOString(),
};

function mockListFetch() {
  return vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ items: [RULE], total: 1, page: 1, page_size: 50, can_mutate: true }),
        { status: 200 },
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mockSearchParams = new URLSearchParams();
});

describe('BannedNamesPage', () => {
  it('is a valid React component', () => {
    expect(BannedNamesPage).toBeDefined();
    expect(typeof BannedNamesPage).toBe('function');
  });

  it('renders a «Срабатывания» link to /events?kinds=banname.matched&rule=<id> when hit_count > 0', async () => {
    vi.stubGlobal('fetch', mockListFetch());
    render(<BannedNamesPage />);
    const link = await screen.findByRole('link', { name: /срабатывания/i });
    expect(link).toHaveAttribute('href', '/events?kinds=banname.matched&rule=rule-1');
  });

  it('shows a dash instead of the link when hit_count is 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ ...RULE, hit_count: 0 }],
              total: 1,
              page: 1,
              page_size: 50,
              can_mutate: true,
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    render(<BannedNamesPage />);
    await screen.findByText('AdolfHitler');
    expect(screen.queryByRole('link', { name: /срабатывания/i })).not.toBeInTheDocument();
  });

  it('highlights the row matching the ?rule= URL param', async () => {
    mockSearchParams = new URLSearchParams('rule=rule-1');
    vi.stubGlobal('fetch', mockListFetch());
    render(<BannedNamesPage />);
    const row = (await screen.findByText('AdolfHitler')).closest('tr');
    await waitFor(() => expect(row?.className).toContain('ring-sky-500'));
  });
});

describe('live preview matching (all three types)', () => {
  it('exact: case-insensitive full match only', () => {
    expect(matchBannedName('AdolfHitler', 'exact', 'adolfhitler')).toBe(true);
    expect(matchBannedName('AdolfHitler', 'exact', 'AdolfHitler123')).toBe(false);
    expect(matchBannedName('AdolfHitler', 'exact', 'nope')).toBe(false);
  });

  it('substring: case-insensitive contains', () => {
    expect(matchBannedName('isis', 'substring', 'xX_ISIS_Xx')).toBe(true);
    expect(matchBannedName('isis', 'substring', 'friendly')).toBe(false);
  });

  it('regex: pattern test against nickname', () => {
    expect(matchBannedName('^\\[ISIS\\]', 'regex', '[ISIS]Fighter')).toBe(true);
    expect(matchBannedName('^\\[ISIS\\]', 'regex', 'clan[ISIS]')).toBe(false);
    expect(matchBannedName('\\d{4}', 'regex', 'player1234')).toBe(true);
  });

  it('regex: invalid pattern never matches and fails validation', () => {
    expect(matchBannedName('([a-z', 'regex', 'anything')).toBe(false);
    const validation = validateBannedNamePattern('([a-z', 'regex');
    expect(validation.ok).toBe(false);
  });

  it('empty pattern never matches and fails validation', () => {
    expect(matchBannedName('', 'exact', 'anything')).toBe(false);
    expect(validateBannedNamePattern('', 'exact').ok).toBe(false);
  });
});
