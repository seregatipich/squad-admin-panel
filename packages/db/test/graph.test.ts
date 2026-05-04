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

import { createDatabaseClient as clientDirect } from '../src/client.js';
import { createDatabaseClient, schema } from '../src/index.js';

describe('db package import graph', () => {
  it('index re-exports createDatabaseClient', () => {
    expect(typeof createDatabaseClient).toBe('function');
  });

  it('index re-exports schema', () => {
    expect(schema).toBeDefined();
  });

  it('client.ts exports createDatabaseClient', () => {
    expect(typeof clientDirect).toBe('function');
  });
});
