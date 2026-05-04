import { describe, expect, it } from 'vitest';

describe('drizzle.config', () => {
  it('specifies postgresql dialect', async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    const mod = await import('../drizzle.config.js');
    const config = mod.default;
    expect(config.dialect).toBe('postgresql');
  });

  it('has an out directory for migrations', async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    const mod = await import('../drizzle.config.js');
    const config = mod.default;
    expect(typeof config.out).toBe('string');
    expect(config.out).toContain('drizzle');
  });
});
