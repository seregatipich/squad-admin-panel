import { EventEmitter } from 'node:events';
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
  type DirectoryDeleteParams,
  type DirectoryDeleteResult,
  type FileReadParams,
  type FileReadTailParams,
  type FileReadTailResult,
  type FileWriteParams,
  type HostAgentRestartResult,
  type HostInfo,
  type HostMetrics,
  type PanelDiskUsage,
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
  method: BridgeRequest['method'];
  startedAt: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onStream?: (frame: BridgeStreamFrame) => void;
  timer?: NodeJS.Timeout;
}

export interface BridgeClientConnectedInfo {
  rttMs: number;
  version: string;
  hostname: string;
}

export interface BridgeClientRpcErrorInfo {
  method: string;
  code: string;
  message: string;
}

export type BridgeClientDisconnectReason =
  | 'socket-error'
  | 'socket-closed'
  | 'frame-decode-error'
  | 'client-closed';

export interface BridgeClientEvents {
  connected: [info: BridgeClientConnectedInfo];
  disconnected: [reason: BridgeClientDisconnectReason];
  'rpc-error': [info: BridgeClientRpcErrorInfo];
  rtt: [rttMs: number];
}

type EventArgs<Events, E extends keyof Events> = Events[E] extends unknown[] ? Events[E] : never;

interface TypedEmitter<Events> {
  on<E extends keyof Events>(event: E, listener: (...args: EventArgs<Events, E>) => void): this;
  off<E extends keyof Events>(event: E, listener: (...args: EventArgs<Events, E>) => void): this;
  once<E extends keyof Events>(event: E, listener: (...args: EventArgs<Events, E>) => void): this;
  emit<E extends keyof Events>(event: E, ...args: EventArgs<Events, E>): boolean;
  removeListener<E extends keyof Events>(
    event: E,
    listener: (...args: EventArgs<Events, E>) => void,
  ): this;
  removeAllListeners<E extends keyof Events>(event?: E): this;
}

export class BridgeClient extends (EventEmitter as new () => TypedEmitter<BridgeClientEvents>) {
  private readonly socketPath: string;
  private readonly defaultTimeoutMs: number;
  private readonly onLog: (msg: string, meta?: Record<string, unknown>) => void;
  private socket?: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingCall>();
  private closed = false;
  private connecting?: Promise<void>;
  private hasEmittedConnectedForCurrentSocket = false;

  constructor(opts: BridgeClientOptions = {}) {
    super();
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
    const wasConnected = this.hasEmittedConnectedForCurrentSocket;
    this.closed = true;
    this.socket?.end();
    this.socket = undefined;
    this.hasEmittedConnectedForCurrentSocket = false;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new BridgeError('transport', 'client closed'));
    }
    this.pending.clear();
    if (wasConnected) {
      this.safeEmit('disconnected', 'client-closed');
    }
  }

  private safeEmit<E extends keyof BridgeClientEvents>(
    event: E,
    ...args: EventArgs<BridgeClientEvents, E>
  ): void {
    try {
      this.emit(event, ...args);
    } catch (err) {
      this.onLog('bridge event listener threw', {
        event,
        err: (err as Error).message,
      });
    }
  }

  ping = () => this.call<PingResult>('ping', undefined, { retryOnTransport: true });

  hostInfo = () => this.call<HostInfo>('host_info', undefined, { retryOnTransport: true });
  hostMetrics = () => this.call<HostMetrics>('host_metrics', undefined, { retryOnTransport: true });

  fileRead = (p: FileReadParams) =>
    this.call<{ content: string }>('file_read', p, { retryOnTransport: true });
  fileReadTail = (p: FileReadTailParams) =>
    this.call<FileReadTailResult>('file_read_tail', p, { retryOnTransport: true });
  fileWrite = (p: FileWriteParams) => this.call<{ status: string }>('file_write', p);
  fileAtomicWrite = (p: FileWriteParams) =>
    this.call<{ status: string }>('file_atomic_write', p, { retryOnTransport: true });

  directoryDelete = (p: DirectoryDeleteParams) =>
    this.call<DirectoryDeleteResult>('directory_delete', p, {
      timeoutMs: 60_000,
      retryOnTransport: true,
    });

  listPanelDirs = () =>
    this.call<{ configs: string[]; saved: string[] }>('list_panel_dirs', undefined, {
      retryOnTransport: true,
    });

  listSquadContainers = () =>
    this.call<{ containers: string[] }>('list_squad_containers', undefined, {
      retryOnTransport: true,
    });

  ufwRule = (p: UfwRuleParams) =>
    this.call<{ output: string; status: string }>('ufw_rule', p, { retryOnTransport: true });

  processInfo = (p: ProcessInfoParams) =>
    this.call<ProcessInfoResult>('process_info', p, { retryOnTransport: true });

  containerRun = (p: ContainerRunParams) =>
    this.call<ContainerRunResult>('container_run', p, { timeoutMs: 60_000 });

  containerStart = (p: ContainerControlParams) =>
    this.call<{ status: string }>('container_start', p, { timeoutMs: 30_000 });

  containerStop = (p: ContainerControlParams) =>
    this.call<{ status: string }>('container_stop', p, { timeoutMs: 120_000 });

  containerRm = (p: ContainerControlParams) =>
    this.call<{ status: string }>('container_rm', p, { timeoutMs: 30_000 });

  containerInspect = (p: ContainerControlParams) =>
    this.call<ContainerInspectResult>('container_inspect', p, {
      timeoutMs: 10_000,
      retryOnTransport: true,
    });

  containerStats = (p: ContainerControlParams) =>
    this.call<ContainerStatsResult>('container_stats', p, {
      timeoutMs: 10_000,
      retryOnTransport: true,
    });

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

  dockerPrune = (onStream?: (frame: BridgeStreamFrame) => void) =>
    this.call<{ exit_code: number; reclaimed_bytes: number; reclaimed_human: string }>(
      'docker_prune',
      undefined,
      { onStream, timeoutMs: 600_000 },
    );

  panelDiskUsage = (opts: { force?: boolean } = {}) =>
    this.call<PanelDiskUsage>('panel_disk_usage', opts.force ? { force: true } : {}, {
      timeoutMs: 30_000,
    });

  hostAgentRestart = () =>
    this.call<HostAgentRestartResult>('host_agent_restart', undefined, { timeoutMs: 5_000 });

  private async call<Result, Params = unknown>(
    method: BridgeRequest['method'],
    params?: Params,
    opts: {
      onStream?: (frame: BridgeStreamFrame) => void;
      timeoutMs?: number;
      retryOnTransport?: boolean;
    } = {},
  ): Promise<Result> {
    const t0 = Date.now();
    this.onLog(`rpc ${method} start`, { src: 'bridge', method });
    const maxAttempts = opts.retryOnTransport && !opts.onStream ? 2 : 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.callImpl<Result, Params>(method, params, opts);
        this.onLog(`rpc ${method} ${Date.now() - t0}ms ok`, {
          src: 'bridge',
          method,
          ms: Date.now() - t0,
          attempt,
        });
        return result;
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        const isTransport = err instanceof BridgeError && err.code === 'transport';
        const willRetry = isTransport && attempt < maxAttempts && !this.closed;
        this.onLog(
          willRetry
            ? `rpc ${method} ${Date.now() - t0}ms transport err (will retry): ${message}`
            : `rpc ${method} ${Date.now() - t0}ms err: ${message}`,
          {
            src: 'bridge',
            method,
            ms: Date.now() - t0,
            err: message,
            attempt,
            ...(willRetry ? { retrying: true } : {}),
          },
        );
        if (!willRetry) break;
        if (this.socket) {
          this.socket.destroy();
          this.socket = undefined;
        }
      }
    }
    throw lastErr;
  }

  private async callImpl<Result, Params = unknown>(
    method: BridgeRequest['method'],
    params?: Params,
    opts: { onStream?: (frame: BridgeStreamFrame) => void; timeoutMs?: number } = {},
  ): Promise<Result> {
    if (this.closed) throw new BridgeError('transport', 'client is closed');
    if (!this.socket) await this.connect();

    const id = uuidv7();
    const req: BridgeRequest = { id, method, params };

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return await new Promise<Result>((resolve, reject) => {
      const pending: PendingCall = {
        method,
        startedAt: Date.now(),
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
      const sock = this.socket as Socket;
      sock.write(encodeFrame(req), (err) => {
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
        const wasConnected = this.hasEmittedConnectedForCurrentSocket;
        this.hasEmittedConnectedForCurrentSocket = false;
        if (wasConnected) {
          this.safeEmit('disconnected', 'frame-decode-error');
        }
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
      const wasConnected = this.hasEmittedConnectedForCurrentSocket;
      this.hasEmittedConnectedForCurrentSocket = false;
      if (this.socket === sock) {
        this.socket = undefined;
      }
      if (wasConnected && !this.closed) {
        this.safeEmit('disconnected', 'socket-closed');
      }
    });
    sock.on('error', (err) => {
      this.onLog('bridge socket error', { err: err.message });
      const wasConnected = this.hasEmittedConnectedForCurrentSocket;
      this.hasEmittedConnectedForCurrentSocket = false;
      if (wasConnected && !this.closed) {
        this.safeEmit('disconnected', 'socket-error');
      }
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
    const rttMs = Date.now() - p.startedAt;
    if (obj.ok) {
      if (
        !this.hasEmittedConnectedForCurrentSocket &&
        p.method === 'ping' &&
        obj.result &&
        typeof obj.result === 'object'
      ) {
        const pingResult = obj.result as Partial<PingResult>;
        if (pingResult.pong === true && typeof pingResult.version === 'string') {
          this.hasEmittedConnectedForCurrentSocket = true;
          this.safeEmit('connected', {
            rttMs,
            version: pingResult.version,
            hostname: typeof pingResult.hostname === 'string' ? pingResult.hostname : '',
          });
        }
      }
      this.safeEmit('rtt', rttMs);
      p.resolve(obj.result);
    } else {
      const err = obj.error ?? { code: 'internal', message: 'no error object' };
      this.safeEmit('rpc-error', {
        method: p.method,
        code: err.code,
        message: err.message,
      });
      p.reject(new BridgeError(err.code, err.message, err.detail));
    }
  }
}
