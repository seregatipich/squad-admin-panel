import { describe, expect, it, vi } from 'vitest';
import { tailContainerLogs } from '../src/tail.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

type FrameCallback = (frame: { stream: string; data: string }) => void;

function makeBridge(frameHandler?: (cb: FrameCallback) => Promise<void>) {
  return {
    containerLogsFollow: vi
      .fn()
      .mockImplementation((_params: unknown, cb: FrameCallback) =>
        frameHandler ? frameHandler(cb) : new Promise(() => {}),
      ),
  } as never;
}

describe('tailContainerLogs', () => {
  it('returns a callable stop function immediately', () => {
    const bridge = makeBridge();
    const stop = tailContainerLogs({
      bridge,
      name: 'squad-srv-001',
      log: makeLogger(),
      onLine: vi.fn(),
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('splits multi-line stdout frames into individual onLine calls', async () => {
    const onLine = vi.fn();
    const onStopped = vi.fn();

    const bridge = makeBridge(async (cb) => {
      cb({ stream: 'stdout', data: 'line one\nline two\nline three\n' });
    });

    tailContainerLogs({
      bridge,
      name: 'squad-srv-002',
      log: makeLogger(),
      onLine,
      onStopped,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onLine).toHaveBeenCalledTimes(3);
    expect(onLine).toHaveBeenNthCalledWith(1, 'line one');
    expect(onLine).toHaveBeenNthCalledWith(2, 'line two');
    expect(onLine).toHaveBeenNthCalledWith(3, 'line three');
  });

  it('ignores stderr frames', async () => {
    const onLine = vi.fn();

    const bridge = makeBridge(async (cb) => {
      cb({ stream: 'stderr', data: 'error output\n' });
      cb({ stream: 'stdout', data: 'good line\n' });
    });

    tailContainerLogs({
      bridge,
      name: 'squad-srv-003',
      log: makeLogger(),
      onLine,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine).toHaveBeenCalledWith('good line');
  });

  it('does not emit empty lines', async () => {
    const onLine = vi.fn();

    const bridge = makeBridge(async (cb) => {
      cb({ stream: 'stdout', data: '\n\nreal line\n\n' });
    });

    tailContainerLogs({
      bridge,
      name: 'squad-srv-004',
      log: makeLogger(),
      onLine,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine).toHaveBeenCalledWith('real line');
  });

  it('calls onStarted before containerLogsFollow resolves', async () => {
    const onStarted = vi.fn();

    const bridge = makeBridge(async (_cb) => {});

    tailContainerLogs({
      bridge,
      name: 'squad-srv-005',
      log: makeLogger(),
      onLine: vi.fn(),
      onStarted,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it('calls onStopped with stream-end reason when containerLogsFollow resolves', async () => {
    const onStopped = vi.fn();

    const bridge = makeBridge(async (_cb) => {});

    tailContainerLogs({
      bridge,
      name: 'squad-srv-006',
      log: makeLogger(),
      onLine: vi.fn(),
      onStopped,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onStopped).toHaveBeenCalledWith({ reason: 'stream-end' });
  });

  it('calls onStopped with stream-error when containerLogsFollow rejects', async () => {
    const onStopped = vi.fn();

    const bridge = makeBridge(async (_cb) => {
      throw new Error('connection lost');
    });

    tailContainerLogs({
      bridge,
      name: 'squad-srv-007',
      log: makeLogger(),
      onLine: vi.fn(),
      onStopped,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onStopped).toHaveBeenCalledWith({ reason: 'stream-error', error: 'connection lost' });
  });

  it('calls onStopped with aborted reason when stop() is called before stream ends', async () => {
    const onStopped = vi.fn();
    let externalCb: FrameCallback | null = null;

    const bridge = makeBridge(
      (cb) =>
        new Promise<void>((resolve) => {
          externalCb = cb;
          setTimeout(resolve, 200);
        }),
    );

    const stop = tailContainerLogs({
      bridge,
      name: 'squad-srv-008',
      log: makeLogger(),
      onLine: vi.fn(),
      onStopped,
    });

    await new Promise((r) => setTimeout(r, 10));
    stop();

    await new Promise((r) => setTimeout(r, 250));
    expect(onStopped).toHaveBeenCalledWith({ reason: 'aborted' });
    expect(externalCb).toBeDefined();
  });

  it('stop() is idempotent', () => {
    const bridge = makeBridge();
    const stop = tailContainerLogs({
      bridge,
      name: 'squad-srv-009',
      log: makeLogger(),
      onLine: vi.fn(),
    });
    expect(() => {
      stop();
      stop();
      stop();
    }).not.toThrow();
  });

  it('buffers partial lines across multiple frame callbacks', async () => {
    const onLine = vi.fn();

    const bridge = makeBridge(async (cb) => {
      cb({ stream: 'stdout', data: 'parti' });
      cb({ stream: 'stdout', data: 'al line\n' });
    });

    tailContainerLogs({
      bridge,
      name: 'squad-srv-010',
      log: makeLogger(),
      onLine,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine).toHaveBeenCalledWith('partial line');
  });
});
