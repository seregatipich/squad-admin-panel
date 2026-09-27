const apiUrl = process.env.API_URL ?? 'http://api:3000';

/**
 * `'unsafe-eval'`, but only outside production.
 *
 * `next dev` compiles every client chunk with an eval-based devtool, so a
 * `script-src` without `'unsafe-eval'` blocks the framework runtime itself:
 * the chunks download with 200s, none of them execute, and every page is
 * frozen on its server-rendered fallback with no hydration and no console
 * error beyond a `securitypolicyviolation` event. `next build` emits no
 * `eval`, so production keeps the strict policy byte-for-byte.
 *
 * Read per `headers()` call rather than at module load so the production
 * branch stays testable.
 */
function devEval() {
  return process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'";
}

function baseCsp() {
  return `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'${devEval()}; style-src 'self' 'unsafe-inline'`;
}

/**
 * The config editor's policy: same origin only.
 *
 * Monaco is vendored into `public/monaco/vs` (see `scripts/sync-monaco.mjs`),
 * so no CDN is allow-listed here any more. Two directives the base policy
 * does not need:
 *
 * - `font-src 'self' data:` — Monaco inlines its codicon icon font as a
 *   `data:` URI. Without this it falls back to `default-src 'self'`, which
 *   refuses `data:` and leaves every editor icon a blank box.
 * - `worker-src 'self' blob:` — the AMD build starts its language workers
 *   from blob URLs.
 */
function configsCsp() {
  return `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'${devEval()}; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'`;
}

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
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: baseCsp() },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        source: '/servers/:id/configs',
        headers: [
          { key: 'Content-Security-Policy', value: configsCsp() },
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
      { source: '/ready', destination: `${apiUrl}/ready` },
    ];
  },
  async redirects() {
    return [
      { source: '/players', destination: '/all-players', permanent: true },
      { source: '/players/:path*', destination: '/all-players/:path*', permanent: true },
    ];
  },
};
