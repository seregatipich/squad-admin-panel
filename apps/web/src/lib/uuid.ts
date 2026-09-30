const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value is a canonical UUID. Route segments such as `[id]` arrive
 * URL-decoded, so a page validates them before building API paths from them —
 * `..%2F..%2Fx` would otherwise decode into a path that climbs to another
 * endpoint (#472).
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
