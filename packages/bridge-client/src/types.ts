import type { BridgeMethod } from '@squad/shared-config';

export type BridgeErrorCode =
  | 'forbidden'
  | 'invalid_args'
  | 'runtime_error'
  | 'timeout'
  | 'internal'
  | 'transport';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly detail?: unknown;

  constructor(code: BridgeErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.detail = detail;
  }
}

export interface BridgeRequest<Params = unknown> {
  id: string;
  method: BridgeMethod;
  params?: Params;
}

export interface BridgeResponse<Result = unknown> {
  id: string;
  ok: boolean;
  result?: Result;
  error?: { code: BridgeErrorCode; message: string; detail?: unknown };
}

export interface BridgeStreamFrame<Data = unknown> {
  id: string;
  stream: 'stdout' | 'stderr' | 'event';
  data: Data;
}

export interface PingResult {
  pong: true;
  version: string;
  hostname: string;
}

export interface HostInfo {
  hostname: string;
  os_name: string;
  os_version: string;
  kernel: string;
  arch: string;
  cpu_model: string;
  cpu_cores: number;
  ram_total_bytes: number;
}

export interface HostMetrics {
  cpu_percent: number;
  ram_used_bytes: number;
  ram_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  net_rx_bytes_per_sec: number;
  net_tx_bytes_per_sec: number;
  sampled_at: string;
}

export interface SystemctlActionParams {
  unit: string;
  action: 'start' | 'stop' | 'restart' | 'status' | 'enable' | 'disable';
}

export interface WriteUnitParams {
  path: string;
  content: string;
}

export interface AptInstallParams {
  packages: string[];
}

export interface SteamcmdRunParams {
  args: string[];
}

export interface FileReadParams {
  path: string;
}

export interface FileWriteParams {
  path: string;
  content: string;
  mode?: number;
}

export interface UfwRuleParams {
  action: 'add' | 'remove';
  port: number;
  proto: 'tcp' | 'udp';
  comment?: string;
}

export interface ProcessInfoParams {
  pid: number;
}

export interface JournalFollowParams {
  unit: string;
  since?: string;
  lines?: number;
}

export interface ProcessInfoResult {
  pid: number;
  exists: boolean;
  rss_bytes?: number;
  vsz_bytes?: number;
  cmdline?: string;
  state?: string;
  threads?: number;
}
