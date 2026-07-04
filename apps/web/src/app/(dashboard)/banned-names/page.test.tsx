import { matchBannedName, validateBannedNamePattern } from '@squad/shared-config/banned-names';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn(), refresh: vi.fn() })),
  usePathname: vi.fn(() => '/banned-names'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock('@/components/LiveIndicator', () => ({ LiveIndicator: () => null }));

import BannedNamesPage from './page';

describe('BannedNamesPage', () => {
  it('is a valid React component', () => {
    expect(BannedNamesPage).toBeDefined();
    expect(typeof BannedNamesPage).toBe('function');
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
