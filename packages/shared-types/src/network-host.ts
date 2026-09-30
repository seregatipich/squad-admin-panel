/**
 * Classifies hosts an operator may point the panel at (external-server RCON,
 * log-source SSH) so none of them can aim the panel's own sockets back at the
 * panel host (#30, finding #333). `worker-rcon` runs with `network_mode: host`
 * and dials the stored host as soon as a server is registered, so a loopback
 * `rcon_host` reaches every service bound to 127.0.0.1 — Redis, Postgres, the
 * bridge — and a link-local one reaches cloud metadata endpoints.
 *
 * Refused: loopback, unspecified, link-local, multicast and reserved
 * addresses (IPv4, IPv6, and IPv4 embedded in IPv6); `localhost` names;
 * Docker/Podman host aliases (`*.docker.internal`, `*.containers.internal`);
 * single-label names (Docker service names such as `redis`); and numeric
 * spellings other than a canonical dotted quad (`127.1`, `2130706433`,
 * `0x7f.0.0.1`), which resolvers would silently turn into loopback. Private
 * LAN ranges stay allowed: a Squad server on the operator's LAN is a normal
 * deployment.
 *
 * Pure string logic with no Node imports, because `apps/web` bundles this
 * package too.
 */

const RESTRICTED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal']);

/** Aliases that resolve to the panel host itself: loopback and the Docker/Podman host gateways. */
const RESTRICTED_SUFFIXES = ['.localhost', '.docker.internal', '.containers.internal'];

/**
 * Whether a canonical IPv4 address falls in a range the panel must never dial.
 *
 * @param octets - The four octets.
 */
function isRestrictedIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

/** Parses a canonical dotted quad (no leading zeros), or returns null. */
function parseCanonicalIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Expands an IPv6 literal to its eight 16-bit groups, or returns null when
 * it is not a valid literal. An IPv4 tail (`::ffff:1.2.3.4`) becomes the last
 * two groups.
 */
function parseIpv6(host: string): number[] | null {
  let text = host;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const lastPart = text.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    const v4 = parseCanonicalIpv4(lastPart);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    tail.push((a << 8) | b, (c << 8) | d);
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const halves = text.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const groups = toGroups(text);
    if (!groups) return null;
    const all = [...groups, ...tail];
    return all.length === 8 ? all : null;
  }
  const head = toGroups(halves[0] as string);
  const rest = toGroups(halves[1] as string);
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  if (known > 7) return null;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}

/** Whether an expanded IPv6 address falls in a range the panel must never dial. */
function isRestrictedIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embeddedV4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (upperZero && g5 === 0 && g6 === 0 && g7 <= 1) return true; // :: and ::1
  if (upperZero && (g5 === 0xffff || g5 === 0)) return isRestrictedIpv4(embeddedV4); // mapped/compat
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isRestrictedIpv4(embeddedV4); // NAT64 64:ff9b::/96
  }
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/**
 * Whether `host` — a hostname, an IPv4 literal, or an IPv6 literal with or
 * without brackets — must be refused as a dial target for operator-supplied
 * connections. Unparseable literals are refused.
 *
 * @param host - The host as the operator typed it, or a resolved address.
 * @returns `true` when the panel must not connect to it.
 */
export function isRestrictedNetworkHost(host: string): boolean {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  if (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  if (normalized === '') return true;

  if (normalized.includes(':')) {
    const groups = parseIpv6(normalized);
    return groups === null || isRestrictedIpv6(groups);
  }

  const labels = normalized.split('.');
  if (labels.every((label) => /^(0x[0-9a-f]*|[0-9]+)$/.test(label))) {
    const octets = parseCanonicalIpv4(normalized);
    return octets === null || isRestrictedIpv4(octets);
  }

  if (RESTRICTED_NAMES.has(normalized) || RESTRICTED_SUFFIXES.some((s) => normalized.endsWith(s))) {
    return true;
  }
  return labels.length < 2;
}
