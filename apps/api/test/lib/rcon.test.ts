import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRconClient } from '../../src/lib/rcon.js';

const SERVER_ID = '019dbaa5-1234-7abc-8def-0123456789ab';
let tmp: string;
let socketPath: string;
let server: Server | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rcon-'));
  socketPath = join(tmp, SERVER_ID, 'sock', 'rcon.sock');
  mkdirSync(join(tmp, SERVER_ID, 'sock'), { recursive: true });
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

describe('rcon.exec', () => {
  it('POSTs to the per-server socket and returns the response', async () => {
    server = createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => {
        buf += c;
      });
      req.on('end', () =>
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, response: `pong:${buf}` })),
      );
    });
    await new Promise<void>((r) => {
      server?.listen(socketPath, r);
    });

    const rcon = createRconClient({ socketDir: tmp });
    const resp = await rcon.exec(SERVER_ID, 'AdminBroadcast', ['gg']);
    expect(resp).toBe('pong:{"method":"AdminBroadcast","args":["gg"]}');
  });

  it('retries on ECONNREFUSED for up to retryMs', async () => {
    const rcon = createRconClient({ socketDir: tmp, retryMs: 1500 });
    const startedAt = Date.now();
    const promise = rcon.exec(SERVER_ID, 'AdminBroadcast', ['gg']);

    setTimeout(async () => {
      server = createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () =>
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: true, response: 'late' })),
        );
      });
      await new Promise<void>((r) => {
        server?.listen(socketPath, r);
      });
    }, 600);

    expect(await promise).toBe('late');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(600);
  });

  it('throws when the sidecar returns ok:false', async () => {
    server = createServer((_req, res) =>
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: 'rcon not connected' })),
    );
    await new Promise<void>((r) => {
      server?.listen(socketPath, r);
    });
    const rcon = createRconClient({ socketDir: tmp });
    await expect(rcon.exec(SERVER_ID, 'AdminBroadcast', ['gg'])).rejects.toThrow(
      /rcon not connected/,
    );
  });
});
