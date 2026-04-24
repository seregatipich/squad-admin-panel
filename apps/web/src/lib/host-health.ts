export type HealthLevel = 'healthy' | 'warning' | 'critical';

export interface HostHealthInputInfo {
  cpu_cores: number;
}

export interface HostHealthInputMetrics {
  cpu_percent: number;
  ram_used_bytes: number;
  ram_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  load_avg_1m: number;
}

export interface HostHealthInputBridge {
  connected: boolean;
}

export interface HostHealth {
  level: HealthLevel;
  reasons: string[];
}

export function computeHostHealth(
  info: HostHealthInputInfo | null,
  metrics: HostHealthInputMetrics | null,
  bridge: HostHealthInputBridge | null,
): HostHealth {
  const reasons: string[] = [];

  if (!bridge || !bridge.connected) {
    return { level: 'critical', reasons: ['bridge disconnected'] };
  }

  if (!info || !metrics) {
    return { level: 'healthy', reasons: [] };
  }

  const diskRatio =
    metrics.disk_total_bytes > 0 ? metrics.disk_used_bytes / metrics.disk_total_bytes : 0;
  if (diskRatio > 0.9) {
    return { level: 'critical', reasons: [`disk ${Math.round(diskRatio * 100)}%`] };
  }

  const ramRatio =
    metrics.ram_total_bytes > 0 ? metrics.ram_used_bytes / metrics.ram_total_bytes : 0;

  if (metrics.cpu_percent > 80) reasons.push(`cpu ${metrics.cpu_percent.toFixed(0)}%`);
  if (ramRatio > 0.85) reasons.push(`ram ${Math.round(ramRatio * 100)}%`);
  if (diskRatio > 0.75) reasons.push(`disk ${Math.round(diskRatio * 100)}%`);
  if (info.cpu_cores > 0 && metrics.load_avg_1m > info.cpu_cores * 1.0) {
    reasons.push(`load ${metrics.load_avg_1m.toFixed(2)}/${info.cpu_cores}`);
  }

  if (reasons.length > 0) return { level: 'warning', reasons };
  return { level: 'healthy', reasons: [] };
}

export function thresholdTone(
  ratio: number,
  warn: number,
  crit: number,
): 'emerald' | 'amber' | 'red' {
  if (ratio >= crit) return 'red';
  if (ratio >= warn) return 'amber';
  return 'emerald';
}
