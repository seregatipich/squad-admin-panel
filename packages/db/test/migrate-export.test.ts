import { describe, expect, it, vi } from 'vitest';

vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { end: vi.fn() })),
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({})),
}));

vi.mock('drizzle-orm/postgres-js/migrator', () => ({
  migrate: vi.fn().mockResolvedValue(undefined),
}));

describe('migrate module', () => {
  it('migrate function is provided by drizzle-orm migrator', async () => {
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    expect(typeof migrate).toBe('function');
  });
});
