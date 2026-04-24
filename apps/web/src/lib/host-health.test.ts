import { describe, expect, it } from 'vitest';
import { computeHostHealth, thresholdTone } from './host-health';

const baseInfo = { cpu_cores: 8 };
const idleMetrics = {
  cpu_percent: 5,
  ram_used_bytes: 1_000_000_000,
  ram_total_bytes: 16_000_000_000,
  disk_used_bytes: 50_000_000_000,
  disk_total_bytes: 500_000_000_000,
  load_avg_1m: 0.4,
};
const connectedBridge = { connected: true };

describe('computeHostHealth', () => {
  it('returns healthy on a relaxed host', () => {
    expect(computeHostHealth(baseInfo, idleMetrics, connectedBridge).level).toBe('healthy');
  });

  it('returns critical when bridge is disconnected', () => {
    expect(computeHostHealth(baseInfo, idleMetrics, { connected: false }).level).toBe('critical');
  });

  it('returns critical when bridge is null', () => {
    expect(computeHostHealth(baseInfo, idleMetrics, null).level).toBe('critical');
  });

  it('returns healthy when info or metrics are missing but bridge is up', () => {
    expect(computeHostHealth(null, null, connectedBridge).level).toBe('healthy');
    expect(computeHostHealth(baseInfo, null, connectedBridge).level).toBe('healthy');
  });

  it('returns critical when disk usage > 90%', () => {
    const r = computeHostHealth(
      baseInfo,
      { ...idleMetrics, disk_used_bytes: 91, disk_total_bytes: 100 },
      connectedBridge,
    );
    expect(r.level).toBe('critical');
  });

  it('does NOT escalate to critical at exactly 90% disk', () => {
    const r = computeHostHealth(
      baseInfo,
      { ...idleMetrics, disk_used_bytes: 90, disk_total_bytes: 100 },
      connectedBridge,
    );
    expect(r.level).toBe('warning');
  });

  it('warns just over 80% cpu', () => {
    const r = computeHostHealth(baseInfo, { ...idleMetrics, cpu_percent: 80.1 }, connectedBridge);
    expect(r.level).toBe('warning');
  });

  it('does not warn at exactly 80% cpu', () => {
    const r = computeHostHealth(baseInfo, { ...idleMetrics, cpu_percent: 80 }, connectedBridge);
    expect(r.level).toBe('healthy');
  });

  it('warns just over 85% ram', () => {
    const r = computeHostHealth(
      baseInfo,
      { ...idleMetrics, ram_used_bytes: 86, ram_total_bytes: 100 },
      connectedBridge,
    );
    expect(r.level).toBe('warning');
  });

  it('does not warn at exactly 85% ram', () => {
    const r = computeHostHealth(
      baseInfo,
      { ...idleMetrics, ram_used_bytes: 85, ram_total_bytes: 100 },
      connectedBridge,
    );
    expect(r.level).toBe('healthy');
  });

  it('warns just over 75% disk', () => {
    const r = computeHostHealth(
      baseInfo,
      { ...idleMetrics, disk_used_bytes: 76, disk_total_bytes: 100 },
      connectedBridge,
    );
    expect(r.level).toBe('warning');
  });

  it('warns when load_avg_1m exceeds cpu_cores', () => {
    const r = computeHostHealth(baseInfo, { ...idleMetrics, load_avg_1m: 8.5 }, connectedBridge);
    expect(r.level).toBe('warning');
  });

  it('does not warn when load equals cpu_cores', () => {
    const r = computeHostHealth(baseInfo, { ...idleMetrics, load_avg_1m: 8.0 }, connectedBridge);
    expect(r.level).toBe('healthy');
  });

  it('skips load comparison when cpu_cores is zero', () => {
    const r = computeHostHealth(
      { cpu_cores: 0 },
      { ...idleMetrics, load_avg_1m: 5 },
      connectedBridge,
    );
    expect(r.level).toBe('healthy');
  });

  it('all-critical-stack still surfaces as critical (disk wins)', () => {
    const r = computeHostHealth(
      baseInfo,
      {
        cpu_percent: 99,
        ram_used_bytes: 99,
        ram_total_bytes: 100,
        disk_used_bytes: 99,
        disk_total_bytes: 100,
        load_avg_1m: 100,
      },
      connectedBridge,
    );
    expect(r.level).toBe('critical');
  });

  it('aggregates multiple warning reasons', () => {
    const r = computeHostHealth(
      baseInfo,
      {
        cpu_percent: 90,
        ram_used_bytes: 90,
        ram_total_bytes: 100,
        disk_used_bytes: 80,
        disk_total_bytes: 100,
        load_avg_1m: 9,
      },
      connectedBridge,
    );
    expect(r.level).toBe('warning');
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('thresholdTone', () => {
  it('returns red at or above critical', () => {
    expect(thresholdTone(0.95, 0.8, 0.95)).toBe('red');
    expect(thresholdTone(1, 0.8, 0.95)).toBe('red');
  });
  it('returns amber between warn and critical', () => {
    expect(thresholdTone(0.81, 0.8, 0.95)).toBe('amber');
  });
  it('returns emerald below warn', () => {
    expect(thresholdTone(0.5, 0.8, 0.95)).toBe('emerald');
  });
});
