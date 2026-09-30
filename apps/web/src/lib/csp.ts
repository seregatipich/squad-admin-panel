/**
 * Content-Security-Policy of the panel's pages, built per request by
 * `src/middleware.ts` so every response carries a fresh script nonce.
 *
 * `script-src` allows same-origin files and the request's nonce, never
 * `'unsafe-inline'`: the panel renders player-supplied strings (names, chat,
 * notes) to an operator whose session can drive the privileged bridge, so an
 * injected `<script>` or `onerror=` must not run (#60, finding 424). Next.js
 * reads the nonce from the request's `Content-Security-Policy` header and puts
 * it on its own inline hydration scripts; that only happens at request time,
 * which is why the root layout renders every page dynamically.
 *
 * `style-src` keeps `'unsafe-inline'`: React `style={{…}}` attributes cannot
 * carry a nonce, and inline styles cannot execute code.
 *
 * @see https://nextjs.org/docs/app/guides/content-security-policy
 */

/** Request header through which middleware hands the nonce to server components. */
export const NONCE_HEADER = 'x-nonce';

/** A fresh 128-bit nonce, base64-encoded. Uses Web Crypto, so it runs in the Edge runtime. */
export function createNonce(): string {
  return btoa(crypto.randomUUID());
}

export interface PolicyOptions {
  /** This request's nonce from {@link createNonce}. */
  nonce: string;
  /**
   * `false` adds `'unsafe-eval'`: `next dev` compiles client chunks with an
   * eval-based devtool, and without it the framework runtime never executes.
   * `next build` emits no `eval`, so production does without.
   */
  production: boolean;
}

/** Steam CDN hosts serving the `avatar_url` values stored by the steam-refresh worker. */
const STEAM_AVATAR_HOSTS = 'https://avatars.steamstatic.com https://avatars.akamai.steamstatic.com';

/**
 * Builds the policy for one response. It is the same for every page: App Router
 * soft navigation (`next/link`) keeps the policy of the document that was loaded
 * first, so a per-route policy would apply to the wrong pages (#1307).
 *
 * Besides the defaults it allows `img-src` for `data:` URIs (Monaco's editor
 * decorations) and the Steam avatar hosts (#1306), `font-src 'self' data:`
 * (Monaco inlines its codicon font) and `worker-src 'self' blob:` (its language
 * workers start from blob URLs). The Monaco bundle is vendored into
 * `public/monaco/vs`, so no CDN is allowed.
 *
 * @returns The `Content-Security-Policy` header value.
 */
export function contentSecurityPolicy({ nonce, production }: PolicyOptions): string {
  const scriptSrc = `script-src 'self' 'nonce-${nonce}'${production ? '' : " 'unsafe-eval'"}`;
  return `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${STEAM_AVATAR_HOSTS}; font-src 'self' data:; worker-src 'self' blob:`;
}
