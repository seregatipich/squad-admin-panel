import { describe, expect, it, vi } from 'vitest';
import { BoundedChain } from '../src/bounded-chain.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('BoundedChain', () => {
  it('runs enqueued work serially, in order', async () => {
    const chain = new BoundedChain(10, () => undefined);
    const order: number[] = [];
    chain.enqueue(async () => {
      order.push(1);
    }, vi.fn());
    chain.enqueue(async () => {
      order.push(2);
    }, vi.fn());
    chain.enqueue(async () => {
      order.push(3);
    }, vi.fn());

    await vi.waitFor(() => expect(order).toEqual([1, 2, 3]));
  });

  it('drops new work instead of growing the backlog once maxDepth is reached', async () => {
    const first = deferred<void>();
    const chain = new BoundedChain(2, () => undefined);
    const onError = vi.fn();

    // in-flight (running) + 2 queued fills the depth-2 backlog
    chain.enqueue(() => first.promise, onError);
    chain.enqueue(async () => undefined, onError);
    expect(chain.queued).toBe(2);

    const onDrop = vi.fn();
    const dropChain = new BoundedChain(2, onDrop);
    const blocking = deferred<void>();
    dropChain.enqueue(() => blocking.promise, onError);
    dropChain.enqueue(async () => undefined, onError);
    expect(dropChain.queued).toBe(2);

    const dropped = vi.fn();
    dropChain.enqueue(async () => {
      dropped();
    }, onError);

    expect(onDrop).toHaveBeenCalledWith(2);
    expect(dropped).not.toHaveBeenCalled();

    blocking.resolve();
    await vi.waitFor(() => expect(dropChain.queued).toBe(0));
    first.resolve();
  });

  it('propagates a work error to onError without breaking later items', async () => {
    const chain = new BoundedChain(10, () => undefined);
    const onError = vi.fn();
    const boom = new Error('boom');

    chain.enqueue(async () => {
      throw boom;
    }, onError);
    const after = vi.fn();
    chain.enqueue(async () => {
      after();
    }, onError);

    await vi.waitFor(() => expect(after).toHaveBeenCalled());
    expect(onError).toHaveBeenCalledWith(boom);
  });
});
