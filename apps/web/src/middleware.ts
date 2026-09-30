// Intentionally thin middleware. It does *not* authorise; that is the
// DAL's job via requireSession(). CVE-2025-29927 showed that using
// middleware as an auth gate is unsafe, and this repo's design
// consistently uses server-side session checks in (dashboard)/layout.tsx.
//
// It does two things: a cookie-presence redirect to /login for the protected
// prefixes, and the per-request Content-Security-Policy with a fresh script
// nonce (see src/lib/csp.ts), which is why it runs on every page.
import { type NextRequest, NextResponse } from 'next/server';
import { contentSecurityPolicy, createNonce, NONCE_HEADER } from '@/lib/csp';

const SESSION_COOKIE = '__Host-sid';

const SESSION_REDIRECT_PREFIXES = ['/dashboard', '/servers', '/all-players', '/audit', '/settings'];

/**
 * Redirects a cookie-less request for a protected prefix to `/login`, and
 * otherwise passes it on with the nonce policy set on both the forwarded
 * request (Next.js reads the nonce from there for its inline scripts) and the
 * response.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    !req.cookies.has(SESSION_COOKIE) &&
    SESSION_REDIRECT_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  const nonce = createNonce();
  const policy = contentSecurityPolicy({
    nonce,
    pathname,
    production: process.env.NODE_ENV === 'production',
  });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Every page. The API (served by Fastify behind the same origin), the
      // health probes and build assets need no document policy.
      source: '/((?!api|health|ready|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
