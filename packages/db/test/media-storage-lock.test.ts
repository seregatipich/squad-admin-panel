import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withMediaStoragePathLock } from '../src/media-storage-lock.js';
import * as schema from '../src/schema/index.js';
import { describeIfDb } from './helpers/describe-if.js';

const DATABASE_URL = process.env.DATABASE_URL;

let pgsql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
  if (!DATABASE_URL) return;
  pgsql = postgres(DATABASE_URL, { max: 5 });
  db = drizzle(pgsql, { schema });
});

afterAll(async () => {
  if (pgsql) await pgsql.end({ timeout: 5 });
});

// Regression for #63 finding 944: withMediaStoragePathLock is what closes the
// TOCTOU between worker-media-publisher's releaseIfEnabled and the api's
// sha256-dedup insert; this proves it actually serializes two callers on the
// same storage_path while leaving unrelated paths free to run concurrently.
describeIfDb('withMediaStoragePathLock', () => {
  it('serializes two concurrent callers on the same storage_path', async () => {
    const order: number[] = [];
    const run = (n: number) =>
      withMediaStoragePathLock(db as never, '2026/07/same-path.mp4', async () => {
        order.push(n);
        await new Promise<void>((r) => setTimeout(r, 80));
        order.push(-n);
      });

    await Promise.all([run(1), run(2)]);

    // One caller's enter/exit pair must fully complete before the other's
    // enter, never interleaved.
    expect(order).toHaveLength(4);
    expect([order[0], order[1]]).toEqual([order[0], -(order[0] as number)]);
  });

  it('does not serialize callers on different storage_paths', async () => {
    const timestamps: Array<{ path: string; ts: number }> = [];
    const run = (storagePath: string) =>
      withMediaStoragePathLock(db as never, storagePath, async () => {
        timestamps.push({ path: storagePath, ts: Date.now() });
        await new Promise<void>((r) => setTimeout(r, 80));
      });

    await Promise.all([run('2026/07/a.mp4'), run('2026/07/b.mp4')]);

    const [first, second] = timestamps as [
      { path: string; ts: number },
      { path: string; ts: number },
    ];
    expect(Math.abs(first.ts - second.ts)).toBeLessThan(50);
  });

  it("rolls back fn's writes when fn throws, and releases the lock", async () => {
    await expect(
      withMediaStoragePathLock(db as never, '2026/07/throwing.mp4', async () => {
        throw new Error('forced');
      }),
    ).rejects.toThrow('forced');

    // The lock must not still be held (or the transaction left open) after
    // the throw — a second call on the same path should proceed promptly.
    const started = Date.now();
    await withMediaStoragePathLock(db as never, '2026/07/throwing.mp4', async () => undefined);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
