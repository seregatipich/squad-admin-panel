/**
 * Outbound-request policy for URLs an operator stores and a panel service
 * later fetches on its own (external ban sources — audit #100). Such a URL
 * must not reach the panel's own network: loopback, the private ranges the
 * Docker Compose network lives in (`redis`, `postgres`, `api`, …), link-local
 * cloud metadata (`169.254.169.254`) or any other non-public address.
 *
 * `checkOutboundUrl` is the static check both the API (on write) and the
 * fetching worker (before each request and redirect hop) apply; the worker
 * additionally checks every address a hostname resolves to with
 * `isPublicUnicastAddress`, because a public-looking name can resolve to a
 * private address. Pure string logic: no `node:*` imports, so the module
 * stays usable from the web bundle.
 */

/** Why {@link checkOutboundUrl} refused a URL. */
export type OutboundUrlRejection =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'credentials_in_url'
  | 'internal_host'
  | 'forbidden_address';

export type OutboundUrlCheck = { ok: true; url: URL } | { ok: false; reason: OutboundUrlRejection };

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Name suffixes that only ever resolve inside a host or a private network. */
const INTERNAL_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

/** IPv4 ranges that are not globally reachable unicast (RFC 6890 special-purpose registry). */
const NON_PUBLIC_IPV4_CIDRS: ReadonlyArray<readonly [number, number]> = [
  [ipv4('0.0.0.0'), 8], // "this" network
  [ipv4('10.0.0.0'), 8], // private
  [ipv4('100.64.0.0'), 10], // carrier-grade NAT
  [ipv4('127.0.0.0'), 8], // loopback
  [ipv4('169.254.0.0'), 16], // link-local, cloud metadata
  [ipv4('172.16.0.0'), 12], // private (Docker's default bridge pools)
  [ipv4('192.0.0.0'), 24], // IETF protocol assignments
  [ipv4('192.0.2.0'), 24], // TEST-NET-1
  [ipv4('192.168.0.0'), 16], // private
  [ipv4('198.18.0.0'), 15], // benchmarking
  [ipv4('198.51.100.0'), 24], // TEST-NET-2
  [ipv4('203.0.113.0'), 24], // TEST-NET-3
  [ipv4('224.0.0.0'), 4], // multicast
  [ipv4('240.0.0.0'), 4], // reserved + limited broadcast
];

function ipv4(dotted: string): number {
  const value = parseIpv4(dotted);
  if (value === null) throw new Error(`invalid IPv4 constant ${dotted}`);
  return value;
}

/** Parses strict dotted-quad IPv4 into an unsigned 32-bit integer, or `null`. */
function parseIpv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isPublicIpv4(value: number): boolean {
  for (const [base, prefix] of NON_PUBLIC_IPV4_CIDRS) {
    const size = 2 ** (32 - prefix);
    if (value >= base && value < base + size) return false;
  }
  return true;
}

/**
 * Parses an IPv6 address (with `::` compression and an optional trailing
 * dotted IPv4) into its eight 16-bit groups, or `null` when malformed.
 */
function parseIpv6(text: string): number[] | null {
  let body = text;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const lastGroup = text.slice(lastColon + 1);
  if (lastGroup.includes('.')) {
    const v4 = parseIpv4(lastGroup);
    if (v4 === null) return null;
    tail.push(Math.floor(v4 / 65536), v4 % 65536);
    // Keep a `::` that directly precedes the IPv4 part; drop a single `:`.
    body = text.slice(0, lastColon + 1);
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (half: string): number[] | null => {
    if (half === '') return [];
    const groups: number[] = [];
    for (const group of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parseGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (head === null || rest === null) return null;
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1) {
    return explicit === 8 ? [...head, ...tail] : null;
  }
  if (explicit > 7) return null;
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...rest, ...tail];
}

function embeddedIpv4(groups: readonly number[]): number {
  return (groups[6] ?? 0) * 65536 + (groups[7] ?? 0);
}

function isPublicIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  const firstSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  // ::/96 covers the unspecified address, loopback and deprecated IPv4-compatible forms.
  if (firstSixZero) return false;
  // ::ffff:0:0/96 IPv4-mapped — judge the embedded IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicIpv4(embeddedIpv4(groups));
  }
  // 64:ff9b::/96 NAT64 — judge the embedded IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicIpv4(embeddedIpv4(groups));
  }
  // 2002::/16 6to4 — the IPv4 address sits in groups 1–2.
  if (g0 === 0x2002) return isPublicIpv4(g1 * 65536 + g2);
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // discard-only
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return false; // multicast ff00::/8
  return true;
}

/**
 * Whether `address` (an IPv4 dotted quad or an IPv6 literal, without
 * brackets) is a globally reachable unicast address a panel service may
 * connect to. Malformed input and scoped IPv6 (`fe80::1%eth0`) are refused.
 *
 * @param address - A literal IP address, e.g. a `dns.lookup` result.
 * @returns `false` for loopback, private, link-local, CGNAT, multicast,
 *   documentation and other special-purpose ranges.
 */
export function isPublicUnicastAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const v4 = parseIpv4(address);
  if (v4 !== null) return isPublicIpv4(v4);
  if (!address.includes(':')) return false;
  const v6 = parseIpv6(address);
  return v6 !== null && isPublicIpv6(v6);
}

/**
 * Static SSRF check for a URL a panel service will fetch unattended.
 *
 * Accepts only `http:`/`https:` URLs without embedded credentials whose host
 * is a public IP literal or a fully qualified name. Single-label names
 * (`redis`, `postgres`, `api` — how Compose services address each other) and
 * internal-only suffixes (`localhost`, `.local`, `.internal`, …) are refused.
 * The WHATWG parser normalises numeric host forms first, so `0x7f.1` and
 * `2130706433` are judged as `127.0.0.1`.
 *
 * A passing name can still resolve to a private address; the fetching side
 * must check resolved addresses with {@link isPublicUnicastAddress}.
 *
 * @param raw - The URL as stored.
 * @returns `{ ok: true, url }` with the parsed URL, or the rejection reason.
 */
export function checkOutboundUrl(raw: string): OutboundUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return { ok: false, reason: 'unsupported_scheme' };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials_in_url' };
  }
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    return isPublicUnicastAddress(host.slice(1, -1))
      ? { ok: true, url }
      : { ok: false, reason: 'forbidden_address' };
  }
  if (parseIpv4(host) !== null) {
    return isPublicUnicastAddress(host)
      ? { ok: true, url }
      : { ok: false, reason: 'forbidden_address' };
  }
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (!name.includes('.') || name === 'localhost') return { ok: false, reason: 'internal_host' };
  if (INTERNAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return { ok: false, reason: 'internal_host' };
  }
  return { ok: true, url };
}
