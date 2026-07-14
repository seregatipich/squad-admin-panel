/**
 * Pure, browser-safe helpers for the ALT-1 alt-detection settings page.
 * Duplicates the shape of `apps/api/src/lib/ip-cidr.ts`'s validation (same
 * PostgreSQL `cidr`-column semantics: host bits under the mask must be zero)
 * without a `node:net` dependency, since this module runs client-side.
 */

const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d|0)';
const IPV4_PATTERN = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);

function isIpv4Address(address: string): boolean {
  return IPV4_PATTERN.test(address);
}

/** Expands an IPv6 address (with optional `::` compression) into 8 hextets, or null if malformed. */
function expandIpv6Groups(address: string): number[] | null {
  const [firstPart, secondPart, ...rest] = address.split('::');
  if (rest.length > 0) return null;

  const parseHextets = (segment: string): number[] | null => {
    if (segment === '') return [];
    const pieces = segment.split(':');
    if (pieces.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return pieces.map((g) => Number.parseInt(g, 16));
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

function ipv4ToBigInt(address: string): bigint {
  return address.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function ipv6ToBigInt(groups: number[]): bigint {
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
}

/**
 * Validates a string as either a bare IPv4/IPv6 address or a CIDR block
 * whose host bits are all zero — i.e. what PostgreSQL's `cidr` column
 * accepts. `10.0.0.0/8` and a bare `10.0.0.5` are valid; `10.0.0.1/8` is
 * rejected (bit 8, a host bit under a /8 mask, is set).
 */
export function isValidIpOrCidr(input: string): boolean {
  const trimmed = input.trim();
  const slashIdx = trimmed.indexOf('/');
  const address = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
  const prefixRaw = slashIdx === -1 ? null : trimmed.slice(slashIdx + 1);

  const ipv6Groups = expandIpv6Groups(address);
  const isV4 = isIpv4Address(address);
  const isV6 = ipv6Groups !== null;
  if (!isV4 && !isV6) return false;

  if (prefixRaw === null) return true;
  if (!/^\d+$/.test(prefixRaw)) return false;
  const prefix = Number(prefixRaw);
  const maxPrefix = isV4 ? 32 : 128;
  if (prefix < 0 || prefix > maxPrefix) return false;

  const value = isV4 ? ipv4ToBigInt(address) : ipv6ToBigInt(ipv6Groups as number[]);
  const hostBits = BigInt(maxPrefix - prefix);
  const hostMask = (1n << hostBits) - 1n;
  return (value & hostMask) === 0n;
}

/** Trims and lowercases a CIDR/IP string for consistent display and comparison. */
export function formatCidr(input: string): string {
  return input.trim().toLowerCase();
}

/** The alt-detection scoring-settings form, keyed like the API's snake_case body. */
export interface AltDetectionSettingsForm {
  weight_shared_ip: number;
  weight_shared_name: number;
  weight_young_account: number;
  weight_steamid_proximity: number;
  steamid_delta_threshold: number;
  medium_threshold: number;
  high_threshold: number;
}

/**
 * Validates the scoring-settings form before submit: every field must be a
 * non-negative integer, and `medium_threshold` must not exceed
 * `high_threshold` (mirrors the API's `alt_detection_settings_thresholds_chk`
 * check constraint, so a client-side rejection never needs a round trip).
 */
export function validateAltDetectionSettingsForm(form: AltDetectionSettingsForm): string | null {
  for (const [key, value] of Object.entries(form)) {
    if (!Number.isInteger(value) || value < 0) {
      return `Поле "${key}" должно быть неотрицательным целым числом.`;
    }
  }
  if (form.medium_threshold > form.high_threshold) {
    return 'Порог "medium" не может быть больше порога "high".';
  }
  return null;
}
