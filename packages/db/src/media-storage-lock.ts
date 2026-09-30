import { sql } from 'drizzle-orm';
import type { DatabaseClient } from './client.js';

/**
 * Serializes any critical section that reads then mutates rows keyed by one
 * `media_files.storage_path`, across every caller that uses this helper —
 * currently the sha256-dedup insert in `apps/api`'s media upload route and
 * `worker-media-publisher`'s `releaseIfEnabled`.
 *
 * Without it, the two race: `releaseIfEnabled` checks for no other row still
 * sharing a storage_path, then nulls it out and deletes the file, while the
 * upload route's dedup path reads that same still-live storage_path and
 * points a brand-new row at it — with no lock between either side's read and
 * write, one side's decision can be stale by the time it acts (#63 finding
 * 944). `pg_advisory_xact_lock` is session/transaction-scoped and released
 * automatically when `fn`'s transaction ends, so `fn` must run its queries
 * against the transaction client it receives, not `db` directly.
 */
export async function withMediaStoragePathLock<T>(
  db: DatabaseClient,
  storagePath: string,
  fn: (tx: DatabaseClient) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${storagePath}))`);
    return fn(tx as unknown as DatabaseClient);
  });
}
