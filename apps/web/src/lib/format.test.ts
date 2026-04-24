import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatBytesPerSec,
  formatPercent,
  formatRelativeTime,
  formatUptime,
  ratio,
} from './format';

describe('formatBytes', () => {
  it('returns 0 B for zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('returns 0 B for negative or NaN', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('formats bytes under 1 KiB', () => {
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats exactly 1 KiB', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
  });

  it('formats 1 MiB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB');
  });

  it('formats 1.5 GiB', () => {
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GiB');
  });

  it('formats large values without decimals once >= 10', () => {
    expect(formatBytes(15 * 1024 ** 3)).toBe('15 GiB');
  });

  it('caps at PiB', () => {
    expect(formatBytes(2 * 1024 ** 5)).toBe('2.0 PiB');
  });
});

describe('formatBytesPerSec', () => {
  it('appends /s', () => {
    expect(formatBytesPerSec(0)).toBe('0 B/s');
    expect(formatBytesPerSec(1024 * 1024)).toBe('1.0 MiB/s');
  });
});

describe('formatPercent', () => {
  it('returns em-dash on zero total', () => {
    expect(formatPercent(0, 0)).toBe('—');
  });

  it('formats with one decimal by default', () => {
    expect(formatPercent(1, 2)).toBe('50.0%');
  });

  it('respects decimals argument', () => {
    expect(formatPercent(1, 3, 0)).toBe('33%');
  });
});

describe('ratio', () => {
  it('returns 0 when total is zero', () => {
    expect(ratio(5, 0)).toBe(0);
  });

  it('returns used/total', () => {
    expect(ratio(5, 10)).toBe(0.5);
  });
});

describe('formatUptime', () => {
  it('renders < 1m for sub-minute', () => {
    expect(formatUptime(0)).toBe('< 1m');
    expect(formatUptime(59)).toBe('< 1m');
  });

  it('renders minutes only for under 1 hour', () => {
    expect(formatUptime(5 * 60)).toBe('5m');
  });

  it('renders hours and minutes', () => {
    expect(formatUptime(2 * 3600 + 13 * 60)).toBe('2h 13m');
  });

  it('renders hours only when minutes are zero', () => {
    expect(formatUptime(3 * 3600)).toBe('3h');
  });

  it('renders days and hours', () => {
    expect(formatUptime(3 * 86400 + 5 * 3600)).toBe('3d 5h');
  });

  it('renders 12d 4h', () => {
    expect(formatUptime(12 * 86400 + 4 * 3600)).toBe('12d 4h');
  });

  it('renders days only when hours are zero', () => {
    expect(formatUptime(7 * 86400)).toBe('7d');
  });

  it('returns < 1m on NaN', () => {
    expect(formatUptime(Number.NaN)).toBe('< 1m');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-04-24T12:00:00Z');

  it('renders seconds-ago', () => {
    expect(formatRelativeTime(new Date('2026-04-24T11:59:57Z'), now)).toBe('3s ago');
  });

  it('renders minutes-ago', () => {
    expect(formatRelativeTime(new Date('2026-04-24T11:58:00Z'), now)).toBe('2m ago');
  });

  it('renders hours-ago under 24h', () => {
    expect(formatRelativeTime(new Date('2026-04-24T07:00:00Z'), now)).toBe('5h ago');
  });

  it('renders > 1d ago for over 24h', () => {
    expect(formatRelativeTime(new Date('2026-04-22T12:00:00Z'), now)).toBe('> 1d ago');
  });

  it('renders только что for future timestamps', () => {
    expect(formatRelativeTime(new Date('2026-04-24T12:00:05Z'), now)).toBe('только что');
  });

  it('returns em-dash on invalid date', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('—');
  });
});
