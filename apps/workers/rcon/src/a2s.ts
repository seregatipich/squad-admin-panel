/**
 * A2S_INFO UDP query implementation for Steam server browser visibility checking.
 *
 * Protocol reference: https://developer.valvesoftware.com/wiki/Server_queries#A2S_INFO
 *
 * Packet layout for A2S_INFO request:
 *   4 bytes: 0xff 0xff 0xff 0xff (header)
 *   1 byte:  0x54 ('T' — request type)
 *   string:  "Source Engine Query\0" (null-terminated)
 *
 * Response type byte (offset 4):
 *   0x49 ('I') — A2S_INFO response
 *   0x41 ('A') — challenge required (modern servers), must resend with challenge bytes
 */

import dgram from 'node:dgram';
import type { LookupAddress } from 'node:dns';
import { lookup as lookupPromise } from 'node:dns/promises';
import type { HostCidr } from '@squad/shared-types';
import { refuseResolvedAddresses } from './address-guard.js';

// A2S_INFO request type
const A2S_INFO_REQUEST = 0x54;
// A2S_INFO response type
const A2S_INFO_RESPONSE = 0x49;
// A2S challenge response type
const A2S_CHALLENGE_RESPONSE = 0x41;
// Standard 4-byte header prefix for all A2S packets
const A2S_HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
// Request payload string (null-terminated)
const A2S_QUERY_STRING = 'Source Engine Query\0';

export interface A2SInfoResult {
  serverName: string;
  map: string;
  players: number;
  maxPlayers: number;
  visible: boolean;
}

/**
 * Builds the A2S_INFO request packet.
 * Format: 0xff 0xff 0xff 0xff 0x54 "Source Engine Query\0"
 */
export function buildA2SInfoRequest(): Buffer {
  const payload = Buffer.from(A2S_QUERY_STRING, 'ascii');
  const buf = Buffer.alloc(4 + 1 + payload.byteLength);
  A2S_HEADER.copy(buf, 0);
  buf[4] = A2S_INFO_REQUEST;
  payload.copy(buf, 5);
  return buf;
}

/**
 * Builds an A2S_INFO request with a 4-byte challenge appended.
 * Used when the server responds with a challenge (0x41).
 */
export function buildA2SChallengeRequest(challenge: Buffer): Buffer {
  const base = buildA2SInfoRequest();
  return Buffer.concat([base, challenge.subarray(0, 4)]);
}

/**
 * Reads a null-terminated UTF-8 string from buf starting at offset.
 * Returns the string and the new offset (position after the null byte).
 */
function readCString(buf: Buffer, offset: number): { value: string; nextOffset: number } {
  const end = buf.indexOf(0x00, offset);
  if (end === -1) {
    return { value: buf.subarray(offset).toString('utf8'), nextOffset: buf.byteLength };
  }
  return { value: buf.subarray(offset, end).toString('utf8'), nextOffset: end + 1 };
}

/**
 * Parses an A2S_INFO response buffer.
 *
 * Returns null if:
 *   - Buffer is too short
 *   - Header bytes are wrong
 *   - Response type is 0x41 (challenge) or anything other than 0x49
 */
export function parseA2SInfoResponse(buf: Buffer): A2SInfoResult | null {
  // Minimum viable response: 4-byte header + 1 type byte + a few more fields
  if (buf.byteLength < 6) return null;

  // Validate 4-byte header
  if (
    buf.readUInt8(0) !== 0xff ||
    buf.readUInt8(1) !== 0xff ||
    buf.readUInt8(2) !== 0xff ||
    buf.readUInt8(3) !== 0xff
  )
    return null;

  const responseType = buf.readUInt8(4);

  // Challenge response — caller should resend with challenge bytes
  if (responseType === A2S_CHALLENGE_RESPONSE) return null;

  // Only handle A2S_INFO responses
  if (responseType !== A2S_INFO_RESPONSE) return null;

  let offset = 5;

  // Skip: protocol byte (1)
  if (offset >= buf.byteLength) return null;
  offset += 1;

  // Read: name (null-terminated string)
  if (offset >= buf.byteLength) return null;
  const nameResult = readCString(buf, offset);
  const serverName = nameResult.value;
  offset = nameResult.nextOffset;

  // Read: map (null-terminated string)
  if (offset >= buf.byteLength) return null;
  const mapResult = readCString(buf, offset);
  const map = mapResult.value;
  offset = mapResult.nextOffset;

  // Read: gameDir (null-terminated string) — skip
  if (offset >= buf.byteLength) return null;
  const gameDirResult = readCString(buf, offset);
  offset = gameDirResult.nextOffset;

  // Read: gameDesc (null-terminated string) — skip
  if (offset >= buf.byteLength) return null;
  const gameDescResult = readCString(buf, offset);
  offset = gameDescResult.nextOffset;

  // Skip: appId (uint16LE, 2 bytes)
  if (offset + 2 > buf.byteLength) return null;
  offset += 2;

  // Read: players (1 byte)
  if (offset >= buf.byteLength) return null;
  const players = buf.readUInt8(offset);
  offset += 1;

  // Read: maxPlayers (1 byte)
  if (offset >= buf.byteLength) return null;
  const maxPlayers = buf.readUInt8(offset);
  offset += 1;

  // Skip: bots (1 byte)
  if (offset >= buf.byteLength) return null;
  offset += 1;

  // Skip: serverType (1 byte)
  if (offset >= buf.byteLength) return null;
  offset += 1;

  // Skip: environment (1 byte)
  if (offset >= buf.byteLength) return null;
  offset += 1;

  // Read: visibility (1 byte) — 0x00 = public/visible, anything else = not visible
  if (offset >= buf.byteLength) return null;
  const visibility = buf.readUInt8(offset);
  const visible = visibility === 0x00;

  return { serverName, map, players, maxPlayers, visible };
}

/** Why an A2S query produced no answer; the panel shows it as "query unavailable". */
export type A2sFailureReason =
  | 'timeout'
  | 'dns_error'
  | 'refused_address'
  | 'socket_error'
  | 'bad_response';

export type A2sQueryOutcome =
  | { ok: true; info: A2SInfoResult }
  | { ok: false; reason: A2sFailureReason };

/** Address policy of an operator-supplied (external) host; see `refuseResolvedAddresses`. */
export interface A2sAddressPolicy {
  /** Private LAN ranges the operator allowed; `null` leaves every private range reachable. */
  privateHostAllowlist?: readonly HostCidr[] | null;
  /** Resolver, `dns.lookup` unless a test substitutes a stub. */
  lookup?: (host: string, options: { all: true; family: 4 }) => Promise<LookupAddress[]>;
}

export interface A2sQueryOptions {
  timeoutMs?: number;
  /**
   * Set for an external server: the host is resolved with `all: true` right
   * before the query and refused when any address is loopback, link-local,
   * unspecified or a private range outside the allowlist (#96). Left unset
   * for a panel-hosted container, which is legitimately reached on loopback.
   */
  addressPolicy?: A2sAddressPolicy;
}

/**
 * Sends an A2S_INFO UDP query to the given host:port and says what happened.
 *
 * Handles the challenge flow: if the server responds with a 0x41 challenge,
 * the request is automatically resent with the challenge bytes appended.
 *
 * The query is sent to the address that was checked, never to the hostname
 * again, so a resolver that answers differently the second time cannot redirect
 * it. Only datagrams whose source is that address and port are accepted, so a
 * packet from any other sender cannot pose as the server's reply.
 *
 * @param host - hostname or IPv4 literal of the server
 * @param port - the server's query port (UDP)
 * @param options - timeout and, for external hosts, the address policy
 * @returns the parsed info, or why there is none
 */
export async function probeA2S(
  host: string,
  port: number,
  options: A2sQueryOptions = {},
): Promise<A2sQueryOutcome> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const policy = options.addressPolicy;
  let serverAddress: string;
  try {
    const resolve = policy?.lookup ?? ((name, opts) => lookupPromise(name, opts));
    const addresses = await resolve(host, { all: true, family: 4 });
    const first = addresses[0];
    if (!first) return { ok: false, reason: 'dns_error' };
    if (
      policy &&
      refuseResolvedAddresses(
        addresses.map((entry) => entry.address),
        policy.privateHostAllowlist ?? null,
      ) !== null
    ) {
      return { ok: false, reason: 'refused_address' };
    }
    serverAddress = first.address;
  } catch {
    return { ok: false, reason: 'dns_error' };
  }

  return new Promise<A2sQueryOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const socket = dgram.createSocket('udp4');

    const finish = (outcome: A2sQueryOutcome) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.close();
      resolve(outcome);
    };

    socket.on('error', () => finish({ ok: false, reason: 'socket_error' }));

    socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      if (rinfo.address !== serverAddress || rinfo.port !== port) return;
      // Check for challenge response (0x41)
      if (
        msg.byteLength >= 9 &&
        msg.readUInt8(0) === 0xff &&
        msg.readUInt8(1) === 0xff &&
        msg.readUInt8(2) === 0xff &&
        msg.readUInt8(3) === 0xff &&
        msg.readUInt8(4) === A2S_CHALLENGE_RESPONSE
      ) {
        // Extract the 4-byte challenge and resend
        const challenge = msg.subarray(5, 9);
        const challengeRequest = buildA2SChallengeRequest(challenge);
        socket.send(
          challengeRequest,
          0,
          challengeRequest.byteLength,
          port,
          serverAddress,
          (err) => {
            if (err) finish({ ok: false, reason: 'socket_error' });
          },
        );
        return;
      }

      // Try to parse as a normal A2S_INFO response
      const info = parseA2SInfoResponse(msg);
      finish(info ? { ok: true, info } : { ok: false, reason: 'bad_response' });
    });

    // Set timeout
    timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);

    // Send initial request
    const request = buildA2SInfoRequest();
    socket.send(request, 0, request.byteLength, port, serverAddress, (err) => {
      if (err) finish({ ok: false, reason: 'socket_error' });
    });
  });
}

/**
 * {@link probeA2S} reduced to the parsed info, or `null` on any failure.
 *
 * @returns the parsed A2S_INFO, `null` on timeout, error or an unparseable reply
 */
export async function queryA2S(
  host: string,
  port: number,
  timeoutMs = 2000,
  options: Omit<A2sQueryOptions, 'timeoutMs'> = {},
): Promise<A2SInfoResult | null> {
  const outcome = await probeA2S(host, port, { ...options, timeoutMs });
  return outcome.ok ? outcome.info : null;
}
