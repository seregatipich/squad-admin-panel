// Intentionally thin middleware. It does *not* authorise; that is the
// DAL's job via requireSession(). CVE-2025-29927 showed that using
// middleware as an auth gate is unsafe, and this repo's design
// consistently uses server-side session checks in (dashboard)/layout.tsx.
import { type NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = '__Host-sid';

export function middleware(req: NextRequest) {
  const hasSession = req.cookies.has(SESSION_COOKIE);
  const { pathname } = req.nextUrl;

  if (
    !hasSession &&
    (pathname.startsWith('/dashboard') ||
      pathname.startsWith('/servers') ||
      pathname.startsWith('/players') ||
      pathname.startsWith('/audit') ||
      pathname.startsWith('/settings'))
  ) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  if (hasSession && pathname === '/login') {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/servers/:path*',
    '/players/:path*',
    '/audit/:path*',
    '/settings/:path*',
    '/login',
  ],
};
