import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createGracefulShutdownController } from '../src/graceful-shutdown.js';

class SignalTarget extends EventEmitter {
  override on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): this {
    return super.on(signal, listener);
  }

  override off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): this {
    return super.off(signal, listener);
  }
}

describe('createGracefulShutdownController', () => {
  it('defers an early signal until startup is ready', async () => {
    const target = new SignalTarget();
    const cleanup = vi.fn(async () => undefined);
    const exit = vi.fn();
    const controller = createGracefulShutdownController({
      cleanup,
      exit,
      signalTarget: target,
    });

    target.emit('SIGTERM', 'SIGTERM');
    expect(controller.isShutdownRequested()).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();

    await expect(controller.markReady()).resolves.toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
    controller.dispose();
  });

  it('runs cleanup once when both signals arrive', async () => {
    const target = new SignalTarget();
    let releaseCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );
    const exit = vi.fn();
    const controller = createGracefulShutdownController({
      cleanup,
      exit,
      signalTarget: target,
    });

    await controller.markReady();
    target.emit('SIGTERM', 'SIGTERM');
    target.emit('SIGINT', 'SIGINT');
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledOnce();

    releaseCleanup?.();
    await expect(controller.request('SIGTERM')).resolves.toBe(0);
    expect(exit).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('reports cleanup failure and exits non-zero', async () => {
    const target = new SignalTarget();
    const onError = vi.fn();
    const exit = vi.fn();
    const controller = createGracefulShutdownController({
      cleanup: async () => {
        throw new Error('cleanup failed');
      },
      onError,
      exit,
      signalTarget: target,
    });

    await controller.markReady();
    await expect(controller.request('SIGTERM')).resolves.toBe(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'cleanup failed' }));
    expect(exit).toHaveBeenCalledWith(1);
    controller.dispose();
  });
});
