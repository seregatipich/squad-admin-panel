import dgram from 'node:dgram';
import { describe, expect, it } from 'vitest';
import {
  type A2SInfoResult,
  buildA2SChallengeRequest,
  buildA2SInfoRequest,
  parseA2SInfoResponse,
  probeA2S,
  queryA2S,
} from '../src/a2s.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Writes a null-terminated UTF-8 string into `buf` at `offset`.
 * Returns the offset after the null byte.
 */
function writeCString(buf: Buffer, offset: number, value: string): number {
  const bytes = Buffer.from(value, 'utf8');
  bytes.copy(buf, offset);
  buf[offset + bytes.byteLength] = 0x00;
  return offset + bytes.byteLength + 1;
}

/**
 * Builds a minimal valid A2S_INFO response buffer with the given field values.
 * Layout mirrors the actual Valve A2S_INFO response format.
 */
function buildValidA2SResponse(
  serverName: string,
  map: string,
  gameDir: string,
  gameDesc: string,
  players: number,
  maxPlayers: number,
  bots: number,
  visibility: number,
): Buffer {
  // Worst-case size: header(4) + type(1) + protocol(1) + 4 strings (max 64 each + null) + appId(2) + players(1) + maxPlayers(1) + bots(1) + serverType(1) + env(1) + visibility(1)
  const buf = Buffer.alloc(512, 0x00);
  let offset = 0;

  // 4-byte header
  buf[offset++] = 0xff;
  buf[offset++] = 0xff;
  buf[offset++] = 0xff;
  buf[offset++] = 0xff;

  // Type byte: 0x49 = A2S_INFO response
  buf[offset++] = 0x49;

  // Protocol byte (skip / ignored)
  buf[offset++] = 0x11;

  // name (null-terminated)
  offset = writeCString(buf, offset, serverName);

  // map (null-terminated)
  offset = writeCString(buf, offset, map);

  // gameDir (null-terminated)
  offset = writeCString(buf, offset, gameDir);

  // gameDesc (null-terminated)
  offset = writeCString(buf, offset, gameDesc);

  // appId (uint16LE) — use a value that fits in 16 bits (actual Squad appId 403240 exceeds uint16)
  buf.writeUInt16LE(0x7654, offset);
  offset += 2;

  // players, maxPlayers, bots
  buf[offset++] = players;
  buf[offset++] = maxPlayers;
  buf[offset++] = bots;

  // serverType ('d' = dedicated)
  buf[offset++] = 0x64;

  // environment ('l' = linux)
  buf[offset++] = 0x6c;

  // visibility
  buf[offset++] = visibility;

  return buf.subarray(0, offset);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildA2SInfoRequest', () => {
  it('builds a packet with the correct 4-byte header', () => {
    const pkt = buildA2SInfoRequest();
    expect(pkt[0]).toBe(0xff);
    expect(pkt[1]).toBe(0xff);
    expect(pkt[2]).toBe(0xff);
    expect(pkt[3]).toBe(0xff);
  });

  it('sets request type byte to 0x54 ("T")', () => {
    const pkt = buildA2SInfoRequest();
    expect(pkt[4]).toBe(0x54);
  });

  it('contains the query string "Source Engine Query"', () => {
    const pkt = buildA2SInfoRequest();
    const payloadStr = pkt.subarray(5).toString('ascii');
    expect(payloadStr.startsWith('Source Engine Query')).toBe(true);
  });

  it('terminates the query string with a null byte', () => {
    const pkt = buildA2SInfoRequest();
    expect(pkt[pkt.byteLength - 1]).toBe(0x00);
  });

  it('has the exact expected byte length (4 + 1 + 20)', () => {
    // "Source Engine Query\0" = 20 bytes (19 chars + null)
    const pkt = buildA2SInfoRequest();
    expect(pkt.byteLength).toBe(4 + 1 + 20);
  });
});

describe('buildA2SChallengeRequest', () => {
  it('starts with the same header and type as the base request', () => {
    const challenge = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const pkt = buildA2SChallengeRequest(challenge);
    const base = buildA2SInfoRequest();
    expect(pkt.subarray(0, base.byteLength)).toEqual(base);
  });

  it('appends the 4 challenge bytes at the end', () => {
    const challenge = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const pkt = buildA2SChallengeRequest(challenge);
    const base = buildA2SInfoRequest();
    const tail = pkt.subarray(base.byteLength);
    expect(tail).toEqual(challenge);
  });

  it('has length = base length + 4', () => {
    const challenge = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const pkt = buildA2SChallengeRequest(challenge);
    const base = buildA2SInfoRequest();
    expect(pkt.byteLength).toBe(base.byteLength + 4);
  });
});

describe('parseA2SInfoResponse', () => {
  it('parses a valid A2S_INFO response and returns all fields correctly', () => {
    const buf = buildValidA2SResponse(
      'My Squad Server',
      'Tallil_RAAS_v1',
      'squad',
      'Squad',
      64,
      100,
      0,
      0x00, // visible (public)
    );

    const result = parseA2SInfoResponse(buf);
    expect(result).not.toBeNull();
    const r = result as A2SInfoResult;
    expect(r.serverName).toBe('My Squad Server');
    expect(r.map).toBe('Tallil_RAAS_v1');
    expect(r.players).toBe(64);
    expect(r.maxPlayers).toBe(100);
    expect(r.visible).toBe(true);
  });

  it('reports visible=false when visibility byte is non-zero', () => {
    const buf = buildValidA2SResponse(
      'Private Server',
      'Jensen_Range_v1',
      'squad',
      'Squad',
      0,
      80,
      0,
      0x01,
    );
    const result = parseA2SInfoResponse(buf);
    expect(result).not.toBeNull();
    expect(result?.visible).toBe(false);
  });

  it('returns null for a packet shorter than 6 bytes', () => {
    expect(parseA2SInfoResponse(Buffer.alloc(0))).toBeNull();
    expect(parseA2SInfoResponse(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBeNull();
    expect(parseA2SInfoResponse(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49]))).toBeNull();
  });

  it('returns null when the 4-byte header is wrong', () => {
    const buf = buildValidA2SResponse('X', 'Y', 'q', 'd', 1, 2, 0, 0x00);
    // Corrupt the header
    buf[0] = 0x00;
    expect(parseA2SInfoResponse(buf)).toBeNull();
  });

  it('returns null for a challenge response (type byte 0x41)', () => {
    // Build a minimal challenge response: header + 0x41 + 4 challenge bytes
    const buf = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 0x01, 0x02, 0x03, 0x04]);
    expect(parseA2SInfoResponse(buf)).toBeNull();
  });

  it('returns null for an unknown response type', () => {
    const buf = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);
    expect(parseA2SInfoResponse(buf)).toBeNull();
  });

  it('handles empty server name and map gracefully', () => {
    const buf = buildValidA2SResponse('', '', 'q', 'd', 0, 0, 0, 0x00);
    const result = parseA2SInfoResponse(buf);
    expect(result).not.toBeNull();
    expect(result?.serverName).toBe('');
    expect(result?.map).toBe('');
  });

  it('correctly reads players and maxPlayers byte values', () => {
    const buf = buildValidA2SResponse('Test', 'Map', 'game', 'desc', 127, 200, 5, 0x00);
    const result = parseA2SInfoResponse(buf);
    expect(result?.players).toBe(127);
    expect(result?.maxPlayers).toBe(200);
  });

  it('returns null when the buffer is truncated after the header', () => {
    const valid = buildValidA2SResponse('Name', 'Map', 'game', 'desc', 1, 2, 0, 0x00);
    // Truncate to just header + type byte + protocol, before any strings
    const truncated = valid.subarray(0, 7);
    // We can't guarantee a specific outcome for "partial" but the function
    // must not throw and must return null or a valid partial result.
    // For a packet that's too short to hold all required fields, null is expected.
    const result = parseA2SInfoResponse(truncated);
    expect(result).toBeNull();
  });

  it('decodes multi-byte server names as UTF-8', () => {
    const result = parseA2SInfoResponse(
      buildValidA2SResponse('Сервер RN', 'Narva', 'squad', 'Squad', 3, 100, 0, 0),
    );
    expect(result?.serverName).toBe('Сервер RN');
  });
});

describe('queryA2S', () => {
  it('ignores a reply that does not come from the queried host and port', async () => {
    const server = dgram.createSocket('udp4');
    const spoofer = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
    const port = server.address().port;

    server.on('message', (_msg, rinfo) => {
      const spoofed = buildValidA2SResponse('SPOOFED', 'Map', 'squad', 'Squad', 1, 2, 0, 0);
      spoofer.send(spoofed, rinfo.port, rinfo.address, () => {
        const genuine = buildValidA2SResponse('GENUINE', 'Map', 'squad', 'Squad', 1, 2, 0, 0);
        server.send(genuine, rinfo.port, rinfo.address);
      });
    });

    try {
      const result = await queryA2S('127.0.0.1', port, 1000);
      expect(result?.serverName).toBe('GENUINE');
    } finally {
      server.close();
      spoofer.close();
    }
  });
});

describe('probeA2S outcomes', () => {
  async function silentServer(): Promise<{ socket: dgram.Socket; port: number }> {
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    return { socket, port: socket.address().port };
  }

  it('returns the parsed info on a reply', async () => {
    const { socket, port } = await silentServer();
    socket.on('message', (_msg, rinfo) => {
      socket.send(
        buildValidA2SResponse('OK', 'Map', 'squad', 'Squad', 3, 80, 0, 0),
        rinfo.port,
        rinfo.address,
      );
    });
    try {
      const outcome = await probeA2S('127.0.0.1', port, { timeoutMs: 1000 });
      expect(outcome).toMatchObject({
        ok: true,
        info: { serverName: 'OK', players: 3, visible: true },
      });
    } finally {
      socket.close();
    }
  });

  it('reports a server that never answers as a timeout, not as hidden', async () => {
    const { socket, port } = await silentServer();
    try {
      expect(await probeA2S('127.0.0.1', port, { timeoutMs: 80 })).toEqual({
        ok: false,
        reason: 'timeout',
      });
    } finally {
      socket.close();
    }
  });

  it('reports an unparseable reply as bad_response', async () => {
    const { socket, port } = await silentServer();
    socket.on('message', (_msg, rinfo) => {
      socket.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x6d, 0x00]), rinfo.port, rinfo.address);
    });
    try {
      expect(await probeA2S('127.0.0.1', port, { timeoutMs: 1000 })).toEqual({
        ok: false,
        reason: 'bad_response',
      });
    } finally {
      socket.close();
    }
  });

  it('reports a host that does not resolve as dns_error', async () => {
    const lookup = async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(
      await probeA2S('nope.example', 27165, { timeoutMs: 80, addressPolicy: { lookup } }),
    ).toEqual({ ok: false, reason: 'dns_error' });
  });
});

describe('probeA2S address policy (#96)', () => {
  /** A UDP server on loopback that counts the queries it receives. */
  async function countingServer(): Promise<{
    socket: dgram.Socket;
    port: number;
    received: () => number;
  }> {
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    let received = 0;
    socket.on('message', (_msg, rinfo) => {
      received += 1;
      socket.send(
        buildValidA2SResponse('LOOP', 'Map', 'squad', 'Squad', 1, 2, 0, 0),
        rinfo.port,
        rinfo.address,
      );
    });
    return { socket, port: socket.address().port, received: () => received };
  }

  const answer =
    (...addresses: string[]) =>
    async () =>
      addresses.map((address) => ({ address, family: 4 }));

  it.each([
    ['loopback', ['127.0.0.1']],
    ['link-local', ['169.254.169.254']],
    ['unspecified', ['0.0.0.0']],
    ['a public answer with a loopback one behind it', ['93.184.216.34', '127.0.0.1']],
    ['an IPv4-mapped loopback', ['::ffff:127.0.0.1']],
  ])(
    'refuses a hostname that resolves to %s without sending a packet',
    async (_label, addresses) => {
      const { socket, port, received } = await countingServer();
      try {
        const outcome = await probeA2S('rebind.example', port, {
          timeoutMs: 200,
          addressPolicy: { lookup: answer(...addresses) },
        });
        expect(outcome).toEqual({ ok: false, reason: 'refused_address' });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(received()).toBe(0);
      } finally {
        socket.close();
      }
    },
  );

  it('refuses a private address outside the allowlist and allows one inside it', async () => {
    const lookup = answer('10.1.2.3');
    expect(
      await probeA2S('lan.example', 27165, {
        timeoutMs: 80,
        addressPolicy: { lookup, privateHostAllowlist: [] },
      }),
    ).toEqual({ ok: false, reason: 'refused_address' });
    // Inside the allowlist the query goes out (nothing listens on 10.1.2.3, so it times out).
    const allowed = await probeA2S('lan.example', 27165, {
      timeoutMs: 80,
      addressPolicy: {
        lookup,
        privateHostAllowlist: [{ address: (0xffffn << 32n) | 0x0a000000n, prefix: 104 }],
      },
    });
    expect(allowed).toEqual({ ok: false, reason: 'timeout' });
  });

  it('queries the address it checked, never the hostname again', async () => {
    const { socket, port, received } = await countingServer();
    let lookups = 0;
    // First answer is what the check sees; a second resolution would be
    // loopback, which is where the test server listens.
    const lookup = async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    };
    try {
      const outcome = await probeA2S('flip.example', port, {
        timeoutMs: 150,
        addressPolicy: { lookup },
      });
      expect(outcome).toEqual({ ok: false, reason: 'timeout' });
      expect(lookups).toBe(1);
      expect(received()).toBe(0);
    } finally {
      socket.close();
    }
  });

  it('does not apply the policy to a panel-hosted server on loopback', async () => {
    const { socket, port } = await countingServer();
    try {
      const outcome = await probeA2S('127.0.0.1', port, { timeoutMs: 1000 });
      expect(outcome).toMatchObject({ ok: true, info: { serverName: 'LOOP' } });
    } finally {
      socket.close();
    }
  });
});
