export interface HostMetricsSample {
  cpu_percent: number;
  ram_used_bytes: number;
  disk_used_bytes: number;
  net_rx_bytes_per_sec: number;
  net_tx_bytes_per_sec: number;
  load_avg_1m: number;
  load_avg_5m: number;
  load_avg_15m: number;
}

export const HOST_METRICS_STREAM = 'host:metrics';
export const HOST_METRICS_MAXLEN = 5760;

const clamp0 = (n: number): number => (n < 0 || Number.isNaN(n) ? 0 : n);
const x100 = (n: number): number => Math.round(clamp0(n) * 100);
const intB = (n: number): number => Math.round(clamp0(n));

export function packHostMetrics(m: HostMetricsSample): number[] {
  return [
    x100(m.cpu_percent),
    intB(m.ram_used_bytes),
    intB(m.disk_used_bytes),
    intB(m.net_rx_bytes_per_sec),
    intB(m.net_tx_bytes_per_sec),
    x100(m.load_avg_1m),
    x100(m.load_avg_5m),
    x100(m.load_avg_15m),
  ];
}

export function unpackHostMetrics(v: number[]): HostMetricsSample {
  return {
    cpu_percent: (v[0] ?? 0) / 100,
    ram_used_bytes: v[1] ?? 0,
    disk_used_bytes: v[2] ?? 0,
    net_rx_bytes_per_sec: v[3] ?? 0,
    net_tx_bytes_per_sec: v[4] ?? 0,
    load_avg_1m: (v[5] ?? 0) / 100,
    load_avg_5m: (v[6] ?? 0) / 100,
    load_avg_15m: (v[7] ?? 0) / 100,
  };
}
