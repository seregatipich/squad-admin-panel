// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatOnlineHours, getPublicClan } from './clan-data';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('getPublicClan', () => {
  it('returns null when the API answers 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(getPublicClan('missing')).resolves.toBeNull();
  });

  it('rethrows every other API failure instead of masking it as not found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(getPublicClan('clan')).rejects.toThrow(/500/);
  });
});

describe('formatOnlineHours', () => {
  it('formats aggregate online seconds in Russian hours', () => {
    expect(formatOnlineHours(5400)).toBe('1,5 ч');
  });

  it('does not render negative activity', () => {
    expect(formatOnlineHours(-1)).toBe('0,0 ч');
  });
});
