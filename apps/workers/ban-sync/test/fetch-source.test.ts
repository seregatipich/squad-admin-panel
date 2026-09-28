import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchSourceError, fetchBanList, publicOnlyLookup } from '../src/fetch-source.js';

/** These tests serve the list from a local server, which the SSRF guard refuses. */
const LOCAL = { allowPrivateAddresses: true };

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

    const result = await fetchBanList(url, 'Bearer secret-token', LOCAL);
    expect(result.text).toBe('Banned:76561198000000001:0');
    expect(receivedAuth).toBe('Bearer secret-token');
  });

  it('rejects eagerly when content-length exceeds the byte cap', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(50 * 1024 * 1024) });
      res.end();
    });
    const url = await listen(server);

    await expect(fetchBanList(url, null, { ...LOCAL, maxBytes: 1024 })).rejects.toMatchObject({
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

    await expect(fetchBanList(url, null, { ...LOCAL, maxBytes: 2048 })).rejects.toMatchObject({
      reason: 'size_limit_exceeded',
    });
  });

  it('times out against a server that never responds', async () => {
    server = createServer(() => {
      // never respond
    });
    const url = await listen(server);

    await expect(fetchBanList(url, null, { ...LOCAL, timeoutMs: 100 })).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('surfaces a non-2xx status as a typed error', async () => {
    server = createServer((_req, res) => {
      res.writeHead(500);
      res.end('server error');
    });
    const url = await listen(server);

    await expect(fetchBanList(url, null, LOCAL)).rejects.toBeInstanceOf(FetchSourceError);
  });

  it('refuses a loopback source without sending it a request (#855)', async () => {
    let requests = 0;
    server = createServer((_req, res) => {
      requests++;
      res.end('Banned:76561198000000001:0');
    });
    const url = await listen(server);

    await expect(fetchBanList(`${url}/bans.cfg`, 'Bearer secret')).rejects.toMatchObject({
      reason: 'forbidden_url',
    });
    await expect(
      fetchBanList(url.replace('127.0.0.1', 'localhost'), 'Bearer secret'),
    ).rejects.toMatchObject({ reason: 'forbidden_url' });
    expect(requests).toBe(0);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal',
    'http://[::1]:3000/',
    'file:///etc/passwd',
  ])('refuses %s (#855)', async (url) => {
    const fetchImpl = vi.fn();

    await expect(
      fetchBanList(url, null, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ reason: 'forbidden_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a redirect to a non-public address before following it (#855)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
    );

    await expect(
      fetchBanList('https://93.184.216.34/bans.cfg', 'Bearer secret', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: 'forbidden_url' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows a public redirect and drops the auth header once it leaves the origin', async () => {
    const fetchImpl = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: '/moved.cfg' } }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://1.1.1.1/cdn.cfg' } }),
      )
      .mockResolvedValueOnce(new Response('Banned:76561198000000001:0', { status: 200 }));

    const result = await fetchBanList('https://93.184.216.34/bans.cfg', 'Bearer secret', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.text).toBe('Banned:76561198000000001:0');
    const calls = fetchImpl.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      'https://93.184.216.34/bans.cfg',
      'https://93.184.216.34/moved.cfg',
      'https://1.1.1.1/cdn.cfg',
    ]);
    expect(calls[1]?.[1].headers).toEqual({ Authorization: 'Bearer secret' });
    expect(calls[2]?.[1].headers).toBeUndefined();
  });

  it('gives up after too many redirects', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: '/again' } }),
    );

    await expect(
      fetchBanList('https://93.184.216.34/bans.cfg', null, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: 'http_status' });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});

describe('publicOnlyLookup (#855)', () => {
  function lookup(hostname: string, options: { all?: boolean }) {
    return new Promise<{ err: Error | null; result: unknown }>((resolve) => {
      publicOnlyLookup(hostname, options, (err, address) => resolve({ err, result: address }));
    });
  }

  it('refuses a hostname that resolves to a loopback address', async () => {
    const single = await lookup('localhost', {});
    const all = await lookup('localhost', { all: true });

    expect(single.err).toMatchObject({ name: 'OutboundUrlError', reason: 'non_public_address' });
    expect(all.err).toMatchObject({ name: 'OutboundUrlError', reason: 'non_public_address' });
  });

  it('passes a resolution failure through unchanged', async () => {
    const { err } = await lookup('does-not-exist.invalid', {});

    expect(err).toMatchObject({ code: expect.stringMatching(/ENOTFOUND|EAI_AGAIN/) });
  });
});
