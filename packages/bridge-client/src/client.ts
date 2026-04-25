import { createConnection, type Socket } from 'node:net';
import { BRIDGE_SOCKET_DEFAULT } from '@squad/shared-config';
import { v7 as uuidv7 } from 'uuid';
import { decodeFrames, encodeFrame } from './frame.js';
import {
  BridgeError,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeStreamFrame,
  type ContainerControlParams,
  type ContainerInspectResult,
  type ContainerLogsParams,
  type ContainerRunParams,
  type ContainerRunResult,
  type ContainerStatsResult,
  type FileReadParams,
  type FileWriteParams,
  type HostAgentRestartResult,
  type HostInfo,
  type HostMetrics,
  type PingResult,
  type ProcessInfoParams,
  type ProcessInfoResult,
  type UfwRuleParams,
} from './types.js';

export interface BridgeClientOptions {
  socketPath?: string;
  defaultTimeoutMs?: number;
  onLog?: (msg: string, meta?: Record<string, unknown>) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onStream?: (frame: BridgeStreamFrame) => void;
  timer?: NodeJS.Timeout;
}

export class BridgeClient {
  private readonly socketPath: string;
  private readonly defaultTimeoutMs: number;
  private readonly onLog: (msg: string, meta?: Record<string, unknown>) => void;
  private socket?: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingCall>();
  private closed = false;
  private connecting?: Promise<void>;

  constructor(opts: BridgeClientOptions = {}) {
    this.socketPath = opts.socketPath ?? BRIDGE_SOCKET_DEFAULT;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15_000;
    this.onLog = opts.onLog ?? (() => undefined);
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = createConnection({ path: this.socketPath });
      const onError = (err: Error) => {
        sock.removeListener('connect', onConnect);
        this.connecting = undefined;
        this.onLog('bridge connect failed', { err: err.message, path: this.socketPath });
        reject(err);
      };
      const onConnect = () => {
        sock.removeListener('error', onError);
        this.socket = sock;
        this.attachHandlers(sock);
        this.connecting = undefined;
        this.onLog('bridge connected', { path: this.socketPath });
        resolve();
      };
      sock.once('error', onError);
      sock.once('connect', onConnect);
    });
    return this.connecting;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.socket?.end();
    this.socket = undefined;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new BridgeError('transport', 'client closed'));
    }
    this.pending.clear();
  }

  ping = () => this.call<PingResult>('ping');

  hostInfo = () => this.call<HostInfo>('host_info');
  hostMetrics = () => this.call<HostMetrics>('host_metrics');

  fileRead = (p: FileReadParams) => this.call<{ content: string }>('file_read', p);
  fileWrite = (p: FileWriteParams) => this.call<{ status: string }>('file_write', p);
  fileAtomicWrite = (p: FileWriteParams) => this.call<{ status: string }>('file_atomic_write', p);

  ufwRule = (p: UfwRuleParams) => this.call<{ output: string; status: string }>('ufw_rule', p);

  processInfo = (p: ProcessInfoParams) => this.call<ProcessInfoResult>('process_info', p);

  containerRun = (p: ContainerRunParams) =>
    this.call<ContainerRunResult>('container_run', p, { timeoutMs: 60_000 });

  containerStart = (p: ContainerControlParams) =>
    this.call<{ status: string }>('container_start', p, { timeoutMs: 30_000 });

  containerStop = (p: ContainerControlParams) =>
    this.call<{ status: string }>('container_stop', p, { timeoutMs: 120_000 });

  containerRm = (p: ContainerControlParams) =>
    this.call<{ status: string }>('container_rm', p, { timeoutMs: 30_000 });

  containerInspect = (p: ContainerControlParams) =>
    this.call<ContainerInspectResult>('container_inspect', p, { timeoutMs: 10_000 });

  containerStats = (p: ContainerControlParams) =>
    this.call<ContainerStatsResult>('container_stats', p, { timeoutMs: 10_000 });

  containerLogsFollow = (p: ContainerLogsParams, onStream: (frame: BridgeStreamFrame) => void) =>
    this.call<{ exit_code: number }>('container_logs_follow', p, {
      onStream,
      timeoutMs: Number.POSITIVE_INFINITY,
    });

  depotUpdate = (onStream: (frame: BridgeStreamFrame) => void) =>
    this.call<{ exit_code: number }>('depot_update', undefined, {
      onStream,
      timeoutMs: 3_600_000,
    });

  hostAgentRestart = () =>
    this.call<HostAgentRestartResult>('host_agent_restart', undefined, { timeoutMs: 5_000 });

  private async call<Result, Params = unknown>(
    method: BridgeRequest['method'],
    params?: Params,
    opts: { onStream?: (frame: BridgeStreamFrame) => void; timeoutMs?: number } = {},
  ): Promise<Result> {
    const t0 = Date.now();
    this.onLog(`rpc ${method} start`, { src: 'bridge', method });
    try {
      const result = await this.callImpl<Result, Params>(method, params, opts);
      this.onLog(`rpc ${method} ${Date.now() - t0}ms ok`, {
        src: 'bridge',
        method,
        ms: Date.now() - t0,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onLog(`rpc ${method} ${Date.now() - t0}ms err: ${message}`, {
        src: 'bridge',
        method,
        ms: Date.now() - t0,
        err: message,
      });
      throw err;
    }
  }

  private async callImpl<Result, Params = unknown>(
    method: BridgeRequest['method'],
    params?: Params,
    opts: { onStream?: (frame: BridgeStreamFrame) => void; timeoutMs?: number } = {},
  ): Promise<Result> {
    if (this.closed) throw new BridgeError('transport', 'client is closed');
    if (!this.socket) await this.connect();
    if (!this.socket) throw new BridgeError('transport', 'socket unavailable after connect');

    const id = uuidv7();
    const req: BridgeRequest = { id, method, params };

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return await new Promise<Result>((resolve, reject) => {
      const pending: PendingCall = {
        resolve: (v) => resolve(v as Result),
        reject,
        onStream: opts.onStream,
      };
      if (Number.isFinite(timeoutMs)) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new BridgeError('timeout', `bridge call ${method} timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      this.socket?.write(encodeFrame(req), (err) => {
        if (err) {
          this.pending.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          reject(new BridgeError('transport', err.message));
        }
      });
    });
  }

  private attachHandlers(sock: Socket) {
    sock.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let decoded: ReturnType<typeof decodeFrames>;
      try {
        decoded = decodeFrames(this.buffer);
      } catch (err) {
        // A framing error means the stream is out-of-sync. Drop the
        // socket so the next call reconnects; do NOT mark the client
        // permanently closed (that would wedge every subsequent call).
        this.onLog('bridge frame decode error; dropping socket', {
          err: (err as Error).message,
        });
        this.buffer = Buffer.alloc(0);
        for (const [, pending] of this.pending) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new BridgeError('transport', (err as Error).message));
        }
        this.pending.clear();
        sock.destroy();
        this.socket = undefined;
        return;
      }
      this.buffer = decoded.remainder;
      for (const f of decoded.frames) {
        this.handleFrame(f);
      }
    });
    sock.on('close', () => {
      this.onLog('bridge socket closed');
      for (const [, pending] of this.pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new BridgeError('transport', 'socket closed'));
      }
      this.pending.clear();
      this.socket = undefined;
    });
    sock.on('error', (err) => {
      this.onLog('bridge socket error', { err: err.message });
    });
  }

  private handleFrame(payload: Buffer) {
    let obj: BridgeResponse | BridgeStreamFrame;
    try {
      obj = JSON.parse(payload.toString('utf-8'));
    } catch {
      this.onLog('bridge frame invalid JSON');
      return;
    }
    if ('stream' in obj) {
      const p = this.pending.get(obj.id);
      p?.onStream?.(obj);
      return;
    }
    const p = this.pending.get(obj.id);
    if (!p) return;
    this.pending.delete(obj.id);
    if (p.timer) clearTimeout(p.timer);
    if (obj.ok) {
      p.resolve(obj.result);
    } else {
      const err = obj.error ?? { code: 'internal', message: 'no error object' };
      p.reject(new BridgeError(err.code, err.message, err.detail));
    }
  }
}
