import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, request } from 'undici';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { RconExecutor } from '../src/rconUnixServer.js';
import { RconUnixServer } from '../src/rconUnixServer.js';

const tmp = mkdtempSync(join(tmpdir(), 'panelbridge-'));
const sock = join(tmp, 'rcon.sock');

const agentFor = (socketPath: string): Agent => new Agent({ connect: { socketPath } });

describe('RconUnixServer', () => {
  let server: RconUnixServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('forwards POST /rcon to the executor and returns its response', async () => {
    const exec = vi.fn<RconExecutor>(
      async (method, args) => `OK:${method}:${JSON.stringify(args)}`,
    );
    server = new RconUnixServer(sock, exec);
    await server.listen();

    const res = await request('http://localhost/rcon', {
      method: 'POST',
      dispatcher: agentFor(sock),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'AdminBroadcast', args: ['gg'] }),
    });
    expect(res.statusCode).toBe(200);
    const body = (await res.body.json()) as { ok: boolean; response: string };
    expect(body).toEqual({ ok: true, response: 'OK:AdminBroadcast:["gg"]' });
    expect(exec).toHaveBeenCalledWith('AdminBroadcast', ['gg']);
  });

  it('returns 400 on missing method', async () => {
    const exec = vi.fn<RconExecutor>(async () => 'unused');
    server = new RconUnixServer(sock, exec);
    await server.listen();

    const res = await request('http://localhost/rcon', {
      method: 'POST',
      dispatcher: agentFor(sock),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: ['gg'] }),
    });
    expect(res.statusCode).toBe(400);
    const body = (await res.body.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'missing or malformed method' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns 400 (not 500) on invalid JSON', async () => {
    const exec = vi.fn<RconExecutor>(async () => 'unused');
    server = new RconUnixServer(sock, exec);
    await server.listen();

    const res = await request('http://localhost/rcon', {
      method: 'POST',
      dispatcher: agentFor(sock),
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.statusCode).toBe(400);
    const body = (await res.body.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects a method containing whitespace instead of forwarding it to exec', async () => {
    const exec = vi.fn<RconExecutor>(async () => 'unused');
    server = new RconUnixServer(sock, exec);
    await server.listen();

    const res = await request('http://localhost/rcon', {
      method: 'POST',
      dispatcher: agentFor(sock),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'AdminBroadcast extra command', args: [] }),
    });
    expect(res.statusCode).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects a body over the size cap with 413 before buffering it fully', async () => {
    const exec = vi.fn<RconExecutor>(async () => 'unused');
    server = new RconUnixServer(sock, exec);
    await server.listen();

    const oversized = JSON.stringify({ method: 'AdminBroadcast', args: ['x'.repeat(20_000)] });
    const res = await request('http://localhost/rcon', {
      method: 'POST',
      dispatcher: agentFor(sock),
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    expect(res.statusCode).toBe(413);
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects when the socket cannot be bound (missing directory)', async () => {
    const missing = new RconUnixServer(
      join(tmp, 'no-such-dir', 'rcon.sock'),
      vi.fn<RconExecutor>(async () => 'unused'),
    );
    await expect(missing.listen()).rejects.toThrow();
  });

  it('chmods the bound socket to 0o770 so the panel-group peer can connect', async () => {
    server = new RconUnixServer(
      sock,
      vi.fn<RconExecutor>(async () => 'ok'),
    );
    await server.listen();
    expect(statSync(sock).mode & 0o777).toBe(0o770);
  });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
