import net from 'node:net';

/**
 * Validates a string as either a bare IPv4/IPv6 address or a CIDR block
 * whose host bits are all zero — i.e. exactly what PostgreSQL's `cidr`
 * column type accepts. `10.0.0.0/8` and a bare `10.0.0.5` are valid;
 * `10.0.0.1/8` is rejected because bit 8 (a host bit under a /8 mask) is
 * set. Used to reject malformed input as a 400 before it ever reaches
 * Postgres (which would otherwise surface an opaque `invalid cidr value`
 * error).
 *
 * IPv4-mapped IPv6 addresses (`::ffff:192.0.2.1`) are not supported and are
 * rejected — the ALT-1 ignore list only needs plain IPv4/IPv6 entries.
 */
export function isValidIpOrCidr(input: string): boolean {
  const trimmed = input.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx === -1) return net.isIP(trimmed) !== 0;

  const address = trimmed.slice(0, slashIdx);
  const prefixRaw = trimmed.slice(slashIdx + 1);
  const version = net.isIP(address);
  if (version === 0 || !/^\d+$/.test(prefixRaw)) return false;

  const prefix = Number(prefixRaw);
  const maxPrefix = version === 4 ? 32 : 128;
  if (prefix < 0 || prefix > maxPrefix) return false;

  const value = ipToBigInt(address, version);
  if (value === null) return false;
  const hostBits = BigInt(maxPrefix - prefix);
  const hostMask = (1n << hostBits) - 1n;
  return (value & hostMask) === 0n;
}

function ipToBigInt(address: string, version: number): bigint | null {
  return version === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
}

function ipv4ToBigInt(address: string): bigint | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(address: string): bigint | null {
  const groups = expandIpv6Groups(address);
  if (!groups) return null;
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

/** Expands an IPv6 address (with optional `::` compression) into 8 hextets. */
function expandIpv6Groups(address: string): number[] | null {
  const [firstPart, secondPart, ...rest] = address.split('::');
  if (rest.length > 0) return null;

  const parseHextets = (segment: string): number[] | null => {
    if (segment === '') return [];
    const hextets = segment.split(':').map((g) => Number.parseInt(g, 16));
    if (hextets.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
    if (segment.split(':').some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return hextets;
  };

  if (secondPart === undefined) {
    const groups = parseHextets(firstPart ?? '');
    return groups && groups.length === 8 ? groups : null;
  }

  const head = parseHextets(firstPart ?? '');
  const tail = parseHextets(secondPart);
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}
