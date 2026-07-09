import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
}));

import { CommandPalette } from './CommandPalette';

describe('CommandPalette', () => {
  it('is a valid React component', () => {
    expect(CommandPalette).toBeDefined();
    expect(typeof CommandPalette).toBe('function');
  });
});
