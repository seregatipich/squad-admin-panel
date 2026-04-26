import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { newClient, shouldSkip } from './lib/client.js';

function decodeExport(buf: Buffer, contentEncoding: string | null): string {
  if (contentEncoding === 'gzip') {
    try {
      return gunzipSync(buf).toString('utf-8');
    } catch {
      // Caddy's `encode gzip` directive may decompress the API's gzip stream
      // transparently while still forwarding the content-encoding header.
      // In that case the body is already plain text.
      return buf.toString('utf-8');
    }
  }
  return buf.toString('utf-8');
}

const skip = shouldSkip();

describe.skipIf(skip.skip)('observability e2e', () => {
  if (skip.skip) {
    it.skip(skip.reason, () => undefined);
    return;
  }

  const c = newClient();

  it('writes bridge heartbeat lines into panel:logs', async () => {
    const entry = await c.waitFor(
      async () =>
        c.json<{ entries: Array<{ source: string; msg: string }> }>(
          '/api/v1/logs?lvl=debug&src=B&limit=200',
        ),
      (v) => v.entries.some((e) => e.source === 'bridge'),
      { timeoutMs: 30_000, intervalMs: 1000, label: 'bridge heartbeat in panel:logs' },
    );
    expect(entry.entries.some((e) => e.source === 'bridge')).toBe(true);
  });

  it('emits rcon connector lines once a server is running', async () => {
    const list = await c.json<{ items: Array<{ id: string; status: string }> }>('/api/v1/servers');
    const running = list.items.find((s) => s.status === 'running');
    if (!running) {
      expect
        .soft(running, 'no running server — install one first to exercise rcon section')
        .toBeDefined();
      return;
    }
    const got = await c.waitFor(
      async () =>
        c.json<{ entries: Array<{ source: string; msg: string }> }>(
          `/api/v1/logs?src=R&srv=${running.id}&limit=200`,
        ),
      (v) => v.entries.some((e) => e.source === 'rcon'),
      { timeoutMs: 90_000, intervalMs: 2000, label: 'rcon line for running server' },
    );
    expect(got.entries.some((e) => e.source === 'rcon')).toBe(true);
  });

  it('serves host metrics history as paired arrays', async () => {
    const body = await c.json<{ ts: number[]; v: number[][] }>(
      '/api/v1/host/metrics/history?seconds=86400',
    );
    expect(Array.isArray(body.ts)).toBe(true);
    expect(Array.isArray(body.v)).toBe(true);
    expect(body.ts.length).toBe(body.v.length);
    if (body.v.length > 0) {
      expect(body.v[0]).toHaveLength(8);
    }
  });

  it('serves a gzipped sectioned export bundle', async () => {
    const res = await c.fetch('/api/v1/logs/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const buf = Buffer.from(await res.arrayBuffer());
    const text = decodeExport(buf, res.headers.get('content-encoding'));
    for (const section of [
      '===== BRIDGE =====',
      '===== HOST METRICS 24h (CSV) =====',
      'ts_iso,cpu_pct,ram_used,disk_used,rx_bps,tx_bps,la1,la5,la15',
      '===== AUDIT (last 24h) =====',
    ]) {
      expect(text, `missing section: ${section}`).toContain(section);
    }
  });
});
