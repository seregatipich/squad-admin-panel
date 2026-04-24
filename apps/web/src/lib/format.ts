export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let unitIndex = 0;
  let value = bytes;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = value < 10 && unitIndex > 0 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

export function formatBytesPerSec(bytes: number): string {
  return `${formatBytes(bytes)}/s`;
}

export function formatPercent(used: number, total: number, decimals = 1): string {
  if (!Number.isFinite(total) || total <= 0) return '—';
  const pct = (used / total) * 100;
  return `${pct.toFixed(decimals)}%`;
}

export function ratio(used: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return used / total;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return '< 1m';
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (seconds < hour) {
    const m = Math.floor(seconds / minute);
    return `${m}m`;
  }
  if (seconds < day) {
    const h = Math.floor(seconds / hour);
    const m = Math.floor((seconds - h * hour) / minute);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / day);
  const h = Math.floor((seconds - d * day) / hour);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export function formatRelativeTime(sampledAt: string | Date, now: Date = new Date()): string {
  const ts = sampledAt instanceof Date ? sampledAt : new Date(sampledAt);
  if (Number.isNaN(ts.getTime())) return '—';
  const diffMs = now.getTime() - ts.getTime();
  if (diffMs < 0) return 'только что';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return '> 1d ago';
}
