export interface BridgeStatus {
  connected: boolean;
  version?: string | null;
  hostname?: string | null;
  round_trip_ms?: number;
  error?: string;
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
  uptime_seconds: number;
  docker_version: string;
  ip_addresses: string[];
}

export interface HostMetrics {
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
}

export interface ServerRow {
  id: string;
  display_name: string;
  slug: string;
  status: string;
  player_count: number | null;
  rcon_state: string | null;
  last_poll_at: string | null;
}

export interface AuditRow {
  id: string;
  created_at: string;
  actor_kind: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  status_code: number | null;
}

export interface ReadyCheck {
  status: 'ok' | 'degraded';
  checks: Record<string, string>;
}

export interface Worker {
  name: string;
  ts: string;
  pid: number;
  started_at: string;
  age_ms: number;
  status?: string;
}

export interface DiskBreakdown {
  configs_bytes: number;
  saved_total_bytes: number;
  saved_per_server: { uuid: string; bytes: number }[];
  depot_volume_bytes: number;
  docker_volumes: { name: string; bytes: number }[];
  docker_images: { repository: string; tag: string; bytes: number }[];
  audit_archive_bytes: number;
  total_panel_bytes: number;
  host_total_bytes: number;
  host_used_bytes: number;
  computed_at: string;
  cache_age_seconds: number;
  panel_pct: number;
  other_pct: number;
}
