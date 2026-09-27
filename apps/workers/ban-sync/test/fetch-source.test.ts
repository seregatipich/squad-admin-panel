import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { type FetchBanListOptions, FetchSourceError, fetchBanList } from '../src/fetch-source.js';

/**
 * The test servers listen on loopback, which the production policy refuses
 * (audit #100); these tests opt that one address back in.
 */
const LOOPBACK_ONLY: FetchBanListOptions = {
  isAddressAllowed: (address) => address === '127.0.0.1',
};

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

    const result = await fetchBanList(url, 'Bearer secret-token', LOOPBACK_ONLY);
    expect(result.text).toBe('Banned:76561198000000001:0');
    expect(receivedAuth).toBe('Bearer secret-token');
  });

  it('rejects eagerly when content-length exceeds the byte cap', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(50 * 1024 * 1024) });
      res.end();
    });
    const url = await listen(server);

    await expect(
      fetchBanList(url, null, { ...LOOPBACK_ONLY, maxBytes: 1024 }),
    ).rejects.toMatchObject({
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

    await expect(
      fetchBanList(url, null, { ...LOOPBACK_ONLY, maxBytes: 2048 }),
    ).rejects.toMatchObject({
      reason: 'size_limit_exceeded',
    });
  });

  it('times out against a server that never responds', async () => {
    server = createServer(() => {
      // never respond
    });
    const url = await listen(server);

    await expect(
      fetchBanList(url, null, { ...LOOPBACK_ONLY, timeoutMs: 100 }),
    ).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('surfaces a non-2xx status as a typed error', async () => {
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end('server error');
    });
    const url = await listen(server);

    await expect(fetchBanList(url, null, LOOPBACK_ONLY)).rejects.toBeInstanceOf(FetchSourceError);
  });
});

// Audit #100 — a stored source URL must not reach the panel's own network.
describe('fetchBanList outbound address policy', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  function recordingServer(handler: Parameters<typeof createServer>[0]): {
    server: Server;
    hits: string[];
  } {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      handler?.(req, res);
    });
    servers.push(server);
    return { server, hits };
  }

  it('refuses a loopback source without connecting to it', async () => {
    const { server, hits } = recordingServer((_req, res) => res.end('Banned:1:0'));
    const url = await listen(server);

    await expect(fetchBanList(url, 'Bearer secret')).rejects.toMatchObject({
      reason: 'forbidden_destination',
    });
    expect(hits).toEqual([]);
  });

  it.each([
    'http://redis:6379/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'file:///etc/passwd',
  ])('refuses %s before any request', async (url) => {
    await expect(fetchBanList(url, null)).rejects.toMatchObject({
      reason: 'forbidden_destination',
    });
  });

  it('refuses a public-looking name that resolves to a private address', async () => {
    const lookups: string[] = [];
    await expect(
      fetchBanList('http://bans.example.com/list.cfg', null, {
        lookup: async (hostname) => {
          lookups.push(hostname);
          return [{ address: '10.0.0.7', family: 4 }];
        },
      }),
    ).rejects.toMatchObject({ reason: 'forbidden_destination' });
    expect(lookups).toEqual(['bans.example.com']);
  });

  it('refuses a redirect into an internal address', async () => {
    const { server } = recordingServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    const url = await listen(server);

    await expect(fetchBanList(url, null, LOOPBACK_ONLY)).rejects.toMatchObject({
      reason: 'forbidden_destination',
    });
  });

  it('follows a same-origin redirect and keeps the auth header', async () => {
    const auth: Array<string | undefined> = [];
    const { server } = recordingServer((req, res) => {
      auth.push(req.headers.authorization);
      if (req.url === '/old') {
        res.writeHead(301, { location: '/new' });
        res.end();
        return;
      }
      res.end('Banned:76561198000000002:0');
    });
    const base = await listen(server);

    const result = await fetchBanList(`${base}/old`, 'Bearer same-origin', LOOPBACK_ONLY);
    expect(result.text).toBe('Banned:76561198000000002:0');
    expect(auth).toEqual(['Bearer same-origin', 'Bearer same-origin']);
  });

  it('drops the auth header on a cross-origin redirect', async () => {
    const targetAuth: Array<string | undefined> = [];
    const target = recordingServer((req, res) => {
      targetAuth.push(req.headers.authorization);
      res.end('Banned:76561198000000003:0');
    });
    const targetUrl = await listen(target.server);
    const origin = recordingServer((_req, res) => {
      res.writeHead(302, { location: `${targetUrl}/list` });
      res.end();
    });
    const originUrl = await listen(origin.server);

    const result = await fetchBanList(originUrl, 'Bearer origin-only', LOOPBACK_ONLY);
    expect(result.text).toBe('Banned:76561198000000003:0');
    expect(targetAuth).toEqual([undefined]);
  });

  it('gives up after too many redirects', async () => {
    const { server } = recordingServer((req, res) => {
      res.writeHead(302, { location: `${req.url ?? '/'}x` });
      res.end();
    });
    const url = await listen(server);

    await expect(fetchBanList(`${url}/`, null, LOOPBACK_ONLY)).rejects.toMatchObject({
      reason: 'http_status',
    });
  });
});
