import { describe, expect, it } from 'vitest';
import {
  type A2SInfoResult,
  buildA2SChallengeRequest,
  buildA2SInfoRequest,
  parseA2SInfoResponse,
} from '../src/a2s.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Writes a null-terminated ASCII string into `buf` at `offset`.
 * Returns the offset after the null byte.
 */
function writeCString(buf: Buffer, offset: number, value: string): number {
  const bytes = Buffer.from(value, 'ascii');
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
});
