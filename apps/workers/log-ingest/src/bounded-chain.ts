/**
 * A serialized `.then()` chain (as used for match/vote/combat ordering in
 * `index.ts`) with a bounded queue depth.
 *
 * The plain pattern (`chain = chain.then(() => work())`) has no backpressure:
 * on a busy server, log lines can arrive faster than `work()` drains, and the
 * chain of pending `.then()` callbacks — plus everything each closure keeps
 * alive — grows without bound (#63 finding 916). `BoundedChain` caps how many
 * items may be queued behind the one currently running; once at capacity,
 * `enqueue` drops the new item and reports it via `onDrop` instead of adding
 * to the backlog, so memory stays bounded under sustained load.
 */
export class BoundedChain {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  constructor(
    private readonly maxDepth: number,
    private readonly onDrop: (queued: number) => void,
  ) {}

  /** Current number of items queued behind the one in flight (0 when idle). */
  get queued(): number {
    return this.depth;
  }

  /**
   * Queues `work`, running it after every previously enqueued item settles.
   * If the queue is already at `maxDepth`, the item is dropped and `onDrop`
   * is invoked instead of being appended.
   */
  enqueue(work: () => Promise<unknown>, onError: (err: unknown) => void): void {
    if (this.depth >= this.maxDepth) {
      this.onDrop(this.depth);
      return;
    }
    this.depth++;
    this.tail = this.tail
      .then(() => work())
      .catch(onError)
      .then(() => {
        this.depth--;
      });
  }
}
