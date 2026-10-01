/** In-memory stand-in for the bridge RPC client used by the integration harness. */

import { BridgeError } from '@squad/bridge-client';

// Fake implementations of every public method on `@squad/bridge-client`
// BridgeClient; signatures must match so routes that accept `app.bridge` work.
// Arguments are passed as params objects (e.g. `{ path }`) and responses match
// the shapes declared in packages/bridge-client/src/types.ts.
export interface FakeBridge {
  ping: () => Promise<{ pong: true; version: string; hostname: string }>;
  hostInfo: () => Promise<{
    hostname: string;
    os_name: string;
    os_version: string;
    kernel: string;
    arch: string;
    cpu_model: string;
    cpu_cores: number;
    ram_total_bytes: number;
    uptime_seconds: number;
    docker_version: string;
    ip_addresses: string[];
  }>;
  hostMetrics: () => Promise<{
    cpu_percent: number;
    ram_used_bytes: number;
    ram_total_bytes: number;
    disk_used_bytes: number;
    disk_total_bytes: number;
    net_rx_bytes_per_sec: number;
    net_tx_bytes_per_sec: number;
    load_avg_1m: number;
    load_avg_5m: number;
    load_avg_15m: number;
    sampled_at: string;
  }>;
  fileRead: (p: { path: string }) => Promise<{ content: string }>;
  fileReadStream: (
    p: { path: string; chunk_size?: number },
    onStream: (frame: { id: string; stream: 'stdout' | 'stderr' | 'event'; data: unknown }) => void,
  ) => Promise<{ bytes_sent: number }>;
  squadLogList: (p: { path: string }) => Promise<{
    files: Array<{ name: string; size: number; mtime: string; is_live: boolean }>;
  }>;
  fileAtomicWrite: (p: {
    path: string;
    content: string;
    mode?: number;
  }) => Promise<{ status: string }>;
  containerInspect: (p: { name: string }) => Promise<{
    name?: string;
    state: string;
    running?: boolean;
    pid?: number;
    started_at?: string;
    finished_at?: string;
    exit_code?: number;
    image?: string;
    restart_count?: number;
    labels?: Record<string, string>;
    oom_killed?: boolean;
    error?: string;
  }>;
  containerStats: (p: { name: string }) => Promise<{
    name: string;
    found: boolean;
    cpu_percent: number;
    mem_used_bytes: number;
    mem_limit_bytes: number;
    mem_percent: number;
    pids: number;
    sampled_at: string;
  }>;
  containerRun: (
    p: Record<string, unknown>,
  ) => Promise<{ container_id: string; status?: 'started' }>;
  containerRunRnsquadjs: (p: {
    server_id: string;
    env: Record<string, string>;
  }) => Promise<{ container_id: string; status?: 'started' }>;
  containerStart: (p: { name: string }) => Promise<{ status: string }>;
  containerStop: (p: { name: string; timeout_sec?: number }) => Promise<{ status: string }>;
  dockerPrune: () => Promise<{
    exit_code: number;
    reclaimed_bytes: number;
    reclaimed_human: string;
  }>;
  containerRm: (p: { name: string; force?: boolean }) => Promise<{ status: string }>;
  containerLogsFollow: (
    p: { name: string; tail?: number },
    onStream: (frame: { id: string; stream: 'stdout' | 'stderr' | 'event'; data: unknown }) => void,
  ) => Promise<{ exit_code: number }>;
  depotUpdate: (
    onStream: (frame: { id: string; stream: 'stdout' | 'stderr' | 'event'; data: unknown }) => void,
  ) => Promise<{ exit_code: number }>;
  ufwRule: (p: {
    action: 'add' | 'remove';
    port: number;
    proto: 'tcp' | 'udp';
    comment?: string;
  }) => Promise<{ output: string; status: string }>;
  directoryDelete: (p: { path: string }) => Promise<{ removed: boolean }>;
  hostAgentRestart: () => Promise<{ status: 'restarting' }>;
  backupSnapshots: () => Promise<{
    snapshots: Array<{
      id: string;
      short_id: string;
      time: string;
      hostname: string;
      paths: string[];
      tags: string[];
    }>;
  }>;
  backupRun: () => Promise<{ exit_code: number }>;
  backupRestore: (p: { snapshot_id: string }) => Promise<{ exit_code: number }>;
  panelDiskUsage: (opts?: { force?: boolean }) => Promise<{
    configs_bytes: number;
    saved_total_bytes: number;
    saved_per_server: Array<{ uuid: string; bytes: number }>;
    depot_volume_bytes: number;
    docker_volumes: Array<{ name: string; bytes: number }>;
    docker_images: Array<{ repository: string; tag: string; bytes: number }>;
    audit_archive_bytes: number;
    total_panel_bytes: number;
    host_total_bytes: number;
    host_used_bytes: number;
    computed_at: string;
    cache_age_seconds: number;
  }>;
  connect(): Promise<void>;
  close(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Overridable in-memory file store; routes use /api/v1/servers/:id/configs
   *  read/write pathways that hit this map via `fileRead`/`fileAtomicWrite`. */
  files: Map<string, Buffer>;
}

export type FakeBridgeOverrides = Partial<FakeBridge>;

export function makeFakeBridge(overrides: FakeBridgeOverrides = {}): FakeBridge {
  const files = new Map<string, Buffer>();
  const base: FakeBridge = {
    files,
    async connect() {},
    async close() {},
    pause() {},
    resume() {},
    ping: async () => ({ pong: true, version: 'test', hostname: 'test-host' }),
    hostInfo: async () => ({
      hostname: 'test-host',
      os_name: 'Ubuntu',
      os_version: '24.04',
      kernel: '6.8',
      arch: 'x86_64',
      cpu_model: 'test-cpu',
      cpu_cores: 8,
      ram_total_bytes: 16 * 1024 ** 3,
      uptime_seconds: 3600,
      docker_version: 'Docker version 27.5.1, build 9f9e405',
      ip_addresses: ['10.0.0.1'],
    }),
    hostMetrics: async () => ({
      cpu_percent: 1,
      ram_used_bytes: 1024 ** 3,
      ram_total_bytes: 16 * 1024 ** 3,
      disk_used_bytes: 10 * 1024 ** 3,
      disk_total_bytes: 100 * 1024 ** 3,
      net_rx_bytes_per_sec: 0,
      net_tx_bytes_per_sec: 0,
      load_avg_1m: 0,
      load_avg_5m: 0,
      load_avg_15m: 0,
      sampled_at: new Date().toISOString(),
    }),
    fileRead: async ({ path }) => {
      const buf = files.get(path);
      if (!buf) throw new BridgeError('not_found', `openat ${path}: no such file or directory`);
      return { content: buf.toString('utf-8') };
    },
    fileReadStream: async ({ path }, onStream) => {
      const buf = files.get(path);
      if (!buf) throw new BridgeError('not_found', `openat ${path}: no such file or directory`);
      onStream({ id: 'fake', stream: 'stdout', data: buf.toString('base64') });
      return { bytes_sent: buf.length };
    },
    squadLogList: async () => ({ files: [] }),
    fileAtomicWrite: async ({ path, content }) => {
      files.set(path, Buffer.from(content, 'utf-8'));
      return { status: 'ok' };
    },
    containerInspect: async ({ name }) => ({
      name,
      state: 'running',
      running: true,
      pid: 1,
      started_at: new Date().toISOString(),
      finished_at: '',
      exit_code: 0,
      image: 'squad-server:latest',
      restart_count: 0,
      labels: {},
    }),
    containerStats: async ({ name }) => ({
      name,
      found: true,
      cpu_percent: 12.5,
      mem_used_bytes: 2 * 1024 ** 3,
      mem_limit_bytes: 16 * 1024 ** 3,
      mem_percent: 12.5,
      pids: 20,
      sampled_at: new Date().toISOString(),
    }),
    containerRun: async () => ({ container_id: 'fake-container-id', status: 'started' }),
    containerRunRnsquadjs: async () => ({ container_id: 'fake-rnsquadjs-id', status: 'started' }),
    containerStart: async () => ({ status: 'ok' }),
    dockerPrune: async () => ({ exit_code: 0, reclaimed_bytes: 0, reclaimed_human: '0B' }),
    containerStop: async () => ({ status: 'ok' }),
    containerRm: async () => ({ status: 'ok' }),
    containerLogsFollow: async () => ({ exit_code: 0 }),
    depotUpdate: async () => ({ exit_code: 0 }),
    ufwRule: async () => ({ output: '', status: 'ok' }),
    directoryDelete: async () => ({ removed: true }),
    hostAgentRestart: async () => ({ status: 'restarting' as const }),
    backupSnapshots: async () => ({ snapshots: [] }),
    backupRun: async () => ({ exit_code: 0 }),
    backupRestore: async () => ({ exit_code: 0 }),
    panelDiskUsage: async () => ({
      configs_bytes: 0,
      saved_total_bytes: 0,
      saved_per_server: [],
      depot_volume_bytes: 0,
      docker_volumes: [],
      docker_images: [],
      audit_archive_bytes: 0,
      total_panel_bytes: 0,
      host_total_bytes: 0,
      host_used_bytes: 0,
      computed_at: new Date().toISOString(),
      cache_age_seconds: 0,
    }),
  };
  return { ...base, ...overrides, files };
}
