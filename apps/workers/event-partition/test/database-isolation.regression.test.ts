import { describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('event-partition test database isolation', () => {
  it('runs against a package-specific database', () => {
    if (!DATABASE_URL) throw new Error('event-partition test database was not provisioned');
    expect(new URL(DATABASE_URL).pathname).toMatch(/^\/sqworker_[0-9a-f]{12}_event_partition$/);
  });
});
