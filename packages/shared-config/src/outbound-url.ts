import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Guards for URLs the panel fetches on an operator's behalf (external ban-list
 * sources, #855). Such a URL must reach the public internet only: loopback,
 * private, link-local (cloud metadata at 169.254.169.254), carrier-grade NAT,
 * docker-network and other special-purpose addresses are refused, so a user
 * allowed to configure a source cannot use the worker to read services inside
 * the host or the compose network.
 *
 * Address ranges follow the IANA special-purpose registries:
 * https://www.iana.org/assignments/iana-ipv4-special-registry and
 * https://www.iana.org/assignments/iana-ipv6-special-registry.
 */

// Two lists, because a `BlockList` matches an IPv4 address against its
// IPv4-mapped IPv6 rules too: the `::ffff:0:0/96` rule would otherwise refuse
// every IPv4 address.
const NON_PUBLIC_IPV4 = new BlockList();
const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  // IPv4-mapped and NAT64 addresses carry an IPv4 address that could be private.
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6');
}

/** Why an outbound URL was refused. */
export type OutboundUrlErrorReason = 'invalid_url' | 'unsupported_scheme' | 'non_public_address';

/** Thrown when a URL the panel would fetch is not an http(s) URL on the public internet. */
export class OutboundUrlError extends Error {
  readonly reason: OutboundUrlErrorReason;

  constructor(reason: OutboundUrlErrorReason, message: string) {
    super(message);
    this.name = 'OutboundUrlError';
    this.reason = reason;
  }
}

/**
 * True when `address` (an IPv4 or IPv6 literal, as `dns.lookup` returns it)
 * is a globally routable unicast address. Anything that is not an IP literal
 * is reported as not public.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !NON_PUBLIC_IPV4.check(address, 'ipv4');
  return !NON_PUBLIC_IPV6.check(address, 'ipv6');
}

/** Strips the brackets WHATWG `URL` keeps around an IPv6 hostname. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

/**
 * Parses `raw` and refuses it unless it is an `http:`/`https:` URL whose host
 * is not `localhost` and not a non-public IP literal. This is the check that
 * needs no DNS: a hostname is accepted here and must additionally be checked
 * where it is resolved (see {@link findNonPublicAddress}).
 *
 * @throws {OutboundUrlError} `invalid_url`, `unsupported_scheme` or `non_public_address`.
 */
export function parseOutboundHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError('invalid_url', 'not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundUrlError('unsupported_scheme', `scheme ${url.protocol} is not allowed`);
  }
  const host = unbracket(url.hostname).toLowerCase();
  const isLiteral = isIP(host) !== 0;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (isLiteral && !isPublicAddress(host))
  ) {
    throw new OutboundUrlError('non_public_address', `host ${host} is not a public address`);
  }
  return url;
}

/** Resolves every address of a hostname, like `dns.lookup(host, { all: true })`. */
export type ResolveAllAddresses = (hostname: string) => Promise<Array<{ address: string }>>;

const resolveAllAddresses: ResolveAllAddresses = (hostname) => lookup(hostname, { all: true });

/**
 * Resolves `hostname` and returns the first address it resolves to that is
 * not public, or `null` when every address is public. A hostname that cannot
 * be resolved also yields `null`: nothing can be fetched from it, and the
 * fetch itself must re-check the addresses it actually connects to.
 */
export async function findNonPublicAddress(
  hostname: string,
  resolve: ResolveAllAddresses = resolveAllAddresses,
): Promise<string | null> {
  const host = unbracket(hostname);
  if (isIP(host) !== 0) return isPublicAddress(host) ? null : host;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolve(host);
  } catch {
    return null;
  }
  return addresses.find((entry) => !isPublicAddress(entry.address))?.address ?? null;
}
