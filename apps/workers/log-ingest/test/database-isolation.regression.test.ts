import { describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('log-ingest package resource isolation', () => {
  it('runs against a dedicated crash-recoverable database', () => {
    if (!DATABASE_URL) throw new Error('log-ingest test database was not provisioned');
    expect(new URL(DATABASE_URL).pathname).toMatch(/^\/sqworker_[0-9a-f]{12}_log_ingest$/);
  });
});
