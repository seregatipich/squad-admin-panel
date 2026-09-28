import { z } from 'zod';

/** Schemes an operator-facing `<a href>` may safely navigate to. */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:']);

/**
 * Whether `value` parses as an absolute URL on an http(s) scheme.
 *
 * Used on both sides of the wire: the API refines `z.string().url()` fields
 * with it (#445) so a stored `javascript:`/`data:` URL is rejected at write
 * time instead of relying on React/browser navigation blocking, and the web
 * app calls it again before rendering an operator-supplied URL in `href`, in
 * case an older row was written before this validation existed.
 */
export function isSafeHttpUrl(value: string): boolean {
  try {
    return SAFE_URL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** `z.string().url()` restricted to `http:`/`https:`, for URLs rendered as a link. */
export function httpUrl(maxLength: number) {
  return z
    .string()
    .url()
    .max(maxLength)
    .refine(isSafeHttpUrl, { message: 'must use the http or https scheme' });
}
