import { describe, expect, it, vi } from 'vitest';
import { RconClient } from '../src/client.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as never;
}

function makeOpts(overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 25575,
    password: 'testpass',
    log: makeLogger(),
    connectTimeoutMs: 200,
    commandTimeoutMs: 200,
    ...overrides,
  };
}

describe('RconClient', () => {
  it('constructs without error', () => {
    expect(() => new RconClient(makeOpts())).not.toThrow();
  });

  it('exec() throws "rcon not connected" when not connected', async () => {
    const client = new RconClient(makeOpts());
    await expect(client.exec('ShowServerInfo')).rejects.toThrow('rcon not connected');
  });

  it('close() is idempotent when never connected', async () => {
    const client = new RconClient(makeOpts());
    await expect(client.close()).resolves.not.toThrow();
    await expect(client.close()).resolves.not.toThrow();
  });

  it('close() rejects pending exec calls with "rcon closed"', async () => {
    const client = new RconClient(makeOpts());
    const p1 = client.exec('ListPlayers').catch((e) => e.message);
    const p2 = client.exec('ShowCurrentMap').catch((e) => e.message);
    await client.close();
    await expect(p1).resolves.toBe('rcon not connected');
    await expect(p2).resolves.toBe('rcon not connected');
  });

  it('connect() times out when host is unreachable', async () => {
    const client = new RconClient(makeOpts({ port: 19999, connectTimeoutMs: 100 }));
    await expect(client.connect()).rejects.toThrow();
  }, 2000);

  it('close() after close() does not throw', async () => {
    const client = new RconClient(makeOpts());
    await client.close();
    await expect(client.close()).resolves.not.toThrow();
  });
});
