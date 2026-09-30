import { z } from 'zod';

/**
 * A zod string schema for URLs that will later be rendered as an `href`
 * (evidence links, ban-source URLs, server join links, …). Bare
 * `z.string().url()` accepts any scheme the WHATWG URL parser understands,
 * including `javascript:` and `data:`; anchoring one of those as `href` is a
 * defense-in-depth gap even though React 19's `sanitizeURL` currently blocks
 * `javascript:` navigation at render time. Restricting the schema to an
 * explicit protocol allowlist closes the gap at the validation boundary
 * instead of relying on the renderer.
 *
 * @param maxLength Maximum string length.
 * @param protocols Allowed URL protocols (including the trailing colon, as
 *   `URL#protocol` reports them). Defaults to `http:`/`https:`; server join
 *   links additionally allow `steam:` for `steam://connect/...` links.
 */
export function httpUrlSchema(
  maxLength: number,
  protocols: readonly string[] = ['http:', 'https:'],
) {
  return z
    .string()
    .max(maxLength)
    .url()
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: `URL must use one of: ${protocols.join(', ')}` },
    );
}

/** Schemes an operator-facing `<a href>` may safely navigate to. */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:']);

/**
 * Whether `value` parses as an absolute URL on an http(s) scheme.
 *
 * The web app calls it before rendering an operator-supplied URL in `href`, in
 * case an older row was written before {@link httpUrlSchema} validated it (#445).
 */
export function isSafeHttpUrl(value: string): boolean {
  try {
    return SAFE_URL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** {@link httpUrlSchema} restricted to `http:`/`https:`, for URLs rendered as a link. */
export function httpUrl(maxLength: number) {
  return httpUrlSchema(maxLength);
}
