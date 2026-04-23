import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { rconSendOnce } from '../src/lib/rcon-send.js';

// Mini RCON server that validates one auth + one command per connection.
function stubServer(opts: {
  expectedPassword: string;
  command: string;
  response: string;
}): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = createServer((sock) => {
      let buf = Buffer.alloc(0);
      let authed = false;
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.byteLength >= 4) {
          const size = buf.readInt32LE(0);
          if (buf.byteLength - 4 < size) return;
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          const body = buf.subarray(12, 4 + size - 2).toString('utf-8');
          buf = buf.subarray(4 + size);
          if (!authed && type === 3) {
            // AUTH
            const ok = body === opts.expectedPassword;
            const empty = encode(id, 0, '');
            const resp = encode(ok ? id : -1, 2, '');
            sock.write(Buffer.concat([empty, resp]));
            authed = ok;
            if (!ok) sock.end();
          } else if (authed && type === 2) {
            if (body === opts.command) {
              sock.write(encode(id, 0, opts.response));
            } else if (body === '') {
              // probe — close the multi-packet window
              sock.write(encode(id, 0, ''));
            }
          }
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise<void>((ok) => srv.close(() => ok())),
      });
    });
    srv.on('error', reject);
  });
}

function encode(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf-8');
  const buf = Buffer.alloc(4 + 4 + payload.byteLength + 2);
  buf.writeInt32LE(id, 0);
  buf.writeInt32LE(type, 4);
  payload.copy(buf, 8);
  const header = Buffer.alloc(4);
  header.writeInt32LE(buf.byteLength, 0);
  return Buffer.concat([header, buf]);
}

const servers: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

describe('rconSendOnce', () => {
  it('authenticates, sends the command, returns the response', async () => {
    const srv = await stubServer({
      expectedPassword: 'secret',
      command: 'AdminBroadcast hi',
      response: 'Broadcast sent',
    });
    servers.push(srv);
    const out = await rconSendOnce({
      host: '127.0.0.1',
      port: srv.port,
      password: 'secret',
      command: 'AdminBroadcast hi',
      connectTimeoutMs: 1000,
      commandTimeoutMs: 2000,
    });
    expect(out).toBe('Broadcast sent');
  });

  it('rejects on bad password', async () => {
    const srv = await stubServer({
      expectedPassword: 'right',
      command: 'x',
      response: 'x',
    });
    servers.push(srv);
    await expect(
      rconSendOnce({
        host: '127.0.0.1',
        port: srv.port,
        password: 'wrong',
        command: 'x',
        connectTimeoutMs: 1000,
        commandTimeoutMs: 2000,
      }),
    ).rejects.toThrow(/rcon auth failed|socket closed/);
  });

  it('rejects on connect timeout to a dropped port', async () => {
    // Port 1 is reserved; connection should fail fast.
    await expect(
      rconSendOnce({
        host: '127.0.0.1',
        port: 1,
        password: 'x',
        command: 'x',
        connectTimeoutMs: 500,
        commandTimeoutMs: 1000,
      }),
    ).rejects.toThrow();
  });
});
