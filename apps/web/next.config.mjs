const apiUrl = process.env.API_URL ?? 'http://api:3000';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The web image build sits on the path of every `dev` deploy, and its type
  // check and lint only repeat dedicated gates: `turbo run typecheck` and
  // `biome check` run in the local pre-push checklist and in ci on master.
  // This package's typecheck runs `next typegen` before `tsc --noEmit`, so
  // it still checks page and layout exports against the generated route types
  // the way the build did. Skipping both here cuts that time from every image
  // build.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // The panel renders no `next/image`, so the `/_next/image` optimizer (and
  // the sharp/libheif decoding behind it) would only be reachable attack
  // surface. With `unoptimized` Next serves no optimizer endpoint at all (#22).
  images: { unoptimized: true },
  // Content-Security-Policy is not set here: it carries a per-request script
  // nonce, so `src/middleware.ts` builds it (`src/lib/csp.ts`) for every page.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
      { source: '/health', destination: `${apiUrl}/health` },
    ];
  },
  async redirects() {
    return [
      { source: '/players', destination: '/all-players', permanent: true },
      { source: '/players/:path*', destination: '/all-players/:path*', permanent: true },
      { source: '/roles', destination: '/settings/groups', permanent: true },
      { source: '/roles/:path*', destination: '/settings/groups', permanent: true },
    ];
  },
};
