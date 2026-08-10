import { describe, expect, it } from 'vitest';
import { testDatabaseNamePattern } from './global-setup.js';

describe('global-setup test database ownership', () => {
  it("matches only its own strict run-id leftovers, never a concurrent run's databases", () => {
    const pattern = testDatabaseNamePattern('0123abcd');

    expect('sqtest_0123abcd_leftover').toMatch(pattern);
    expect('sqtmpl_0123abcd_shared_0123456789ab').toMatch(pattern);
    expect('sqworker_0123abcd_leftover').toMatch(pattern);
    expect('sqworker_deadbeef_leftover').not.toMatch(pattern);
    expect('sqtestX0123abcdYleftover').not.toMatch(pattern);
    expect('sqtest_0123abcd_').not.toMatch(pattern);
    expect('sqtest_0123ABCD_leftover').not.toMatch(pattern);
    expect('production_0123abcd_leftover').not.toMatch(pattern);
  });

  it('rejects a malformed run id before constructing a database query', () => {
    expect(() => testDatabaseNamePattern('0123abc')).toThrow(/exactly 8 lowercase hexadecimal/);
    expect(() => testDatabaseNamePattern('0123ABCD')).toThrow(/exactly 8 lowercase hexadecimal/);
  });
});
