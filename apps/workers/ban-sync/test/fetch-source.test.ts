import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchSourceError, fetchBanList } from '../src/fetch-source.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return `http://127.0.0.1:${address.port}`;
}

describe('fetchBanList', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
  });

  it('sends the auth header and returns the body', async () => {
    let receivedAuth: string | undefined;
    server = createServer((req, res) => {
      receivedAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Banned:76561198000000001:0');
    });
    const url = await listen(server);

    const result = await fetchBanList(url, 'Bearer secret-token');
    expect(result.text).toBe('Banned:76561198000000001:0');
    expect(receivedAuth).toBe('Bearer secret-token');
  });

  it('rejects eagerly when content-length exceeds the byte cap', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(50 * 1024 * 1024) });
      res.end();
    });
    const url = await listen(server);

    await expect(fetchBanList(url, null, { maxBytes: 1024 })).rejects.toMatchObject({
      reason: 'size_limit_exceeded',
    });
  });

  it('aborts mid-stream once the body crosses the byte cap even without a content-length header', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      // Stream chunks without a content-length so the cap can only be
      // enforced by counting bytes as they arrive.
      const chunk = 'x'.repeat(1024);
      const interval = setInterval(() => res.write(chunk), 5);
      res.socket?.on('close', () => clearInterval(interval));
      setTimeout(() => {
        clearInterval(interval);
        res.end();
      }, 500);
    });
    const url = await listen(server);

    await expect(fetchBanList(url, null, { maxBytes: 2048 })).rejects.toMatchObject({
      reason: 'size_limit_exceeded',
    });
  });

  it('times out against a server that never responds', async () => {
    server = createServer(() => {
      // never respond
    });
    const url = await listen(server);

    await expect(fetchBanList(url, null, { timeoutMs: 100 })).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('surfaces a non-2xx status as a typed error', async () => {
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end('server error');
    });
    const url = await listen(server);

    await expect(fetchBanList(url, null)).rejects.toBeInstanceOf(FetchSourceError);
  });
});
