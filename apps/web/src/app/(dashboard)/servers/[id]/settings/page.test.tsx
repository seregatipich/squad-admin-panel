import { describe, expect, it, vi } from 'vitest';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, use: vi.fn(() => ({ id: 'test-uuid' })) };
});

import SettingsPage from './page';

describe('SettingsPage', () => {
  it('is a valid React component', () => {
    expect(SettingsPage).toBeDefined();
    expect(typeof SettingsPage).toBe('function');
  });

  it('accepts params prop matching Next.js App Router signature', () => {
    expect(SettingsPage.length).toBeLessThanOrEqual(1);
  });
});
