import { mkdtempSync, rmSync } from 'node:fs';
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
    expect(body).toEqual({ ok: false, error: 'missing method' });
    expect(exec).not.toHaveBeenCalled();
  });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
