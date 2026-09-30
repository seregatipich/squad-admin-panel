import { unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient } from '@squad/bridge-client';
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
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('tailContainerLogs', () => {
  it('returns a callable stop function immediately', () => {
    const bridge = makeBridge();
    const stop = tailContainerLogs({
      openBridge: () => bridge as never,
      name: 'squad-srv-001',
      log: makeLogger(),
      onLine: vi.fn(),
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('strips the trailing carriage return from CRLF lines like the SSH tail does', async () => {
    const onLine = vi.fn();
    const bridge = makeBridge(async (cb) => {
      cb({ stream: 'stdout', data: 'crlf line\r\nplain\n' });
    });
    tailContainerLogs({
      openBridge: () => bridge as never,
      name: 'squad-srv-crlf',
      log: makeLogger(),
      onLine,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onLine.mock.calls.map((call) => call[0])).toEqual(['crlf line', 'plain']);
  });

  it('splits multi-line stdout frames into individual onLine calls', async () => {
    const onLine = vi.fn();
    const onStopped = vi.fn();

    const bridge = makeBridge(async (cb) => {
      cb({ stream: 'stdout', data: 'line one\nline two\nline three\n' });
    });

    tailContainerLogs({
      openBridge: () => bridge as never,
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
      openBridge: () => bridge as never,
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
      openBridge: () => bridge as never,
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
      openBridge: () => bridge as never,
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
      openBridge: () => bridge as never,
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
      openBridge: () => bridge as never,
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
      openBridge: () => bridge as never,
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
      openBridge: () => bridge as never,
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
      openBridge: () => bridge as never,
      name: 'squad-srv-010',
      log: makeLogger(),
      onLine,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine).toHaveBeenCalledWith('partial line');
  });

  it('closes its own bridge connection when stopped', () => {
    const bridge = makeBridge();
    const openBridge = vi.fn(() => bridge as never);
    const stop = tailContainerLogs({
      openBridge,
      name: 'squad-srv-011',
      log: makeLogger(),
      onLine: vi.fn(),
    });
    expect(openBridge).toHaveBeenCalledOnce();
    stop();
    expect(bridge.close).toHaveBeenCalled();
  });

  it('closes its own bridge connection when the stream ends', async () => {
    const bridge = makeBridge(async () => {});
    tailContainerLogs({
      openBridge: () => bridge as never,
      name: 'squad-srv-012',
      log: makeLogger(),
      onLine: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.close).toHaveBeenCalled();
  });
});

describe('tailContainerLogs against a bridge socket', () => {
  /**
   * The bridge stops a follow (and kills its `docker logs -f`) only when the
   * connection carrying it closes. Each tail therefore needs its own
   * connection, and stopping the tail must end it.
   */
  it('gives every tail its own connection and ends it on stop', async () => {
    const socketPath = join(tmpdir(), `log-ingest-tail-${process.pid}-${Date.now()}.sock`);
    const connections: Socket[] = [];
    const closed: Socket[] = [];
    const followRequests: string[] = [];
    const server = createServer((connection) => {
      connections.push(connection);
      connection.on('data', (chunk) => {
        const size = chunk.readUInt32BE(0);
        const request = JSON.parse(chunk.subarray(4, 4 + size).toString('utf8')) as {
          method: string;
        };
        followRequests.push(request.method);
      });
      connection.on('close', () => closed.push(connection));
      connection.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const onStopped = vi.fn();
      const openBridge = () => new BridgeClient({ socketPath });
      const stops = ['squad-a', 'squad-b'].map((name) =>
        tailContainerLogs({ openBridge, name, log: makeLogger(), onLine: vi.fn(), onStopped }),
      );
      await vi.waitFor(() => expect(followRequests).toHaveLength(2));
      expect(connections).toHaveLength(2);

      stops[0]?.();
      await vi.waitFor(() => expect(closed).toEqual([connections[0]]));
      await vi.waitFor(() =>
        expect(onStopped).toHaveBeenCalledWith(expect.objectContaining({ reason: 'aborted' })),
      );

      stops[1]?.();
      await vi.waitFor(() => expect(closed).toHaveLength(2));
    } finally {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(socketPath);
      } catch {}
    }
  });
});
