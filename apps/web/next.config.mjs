const apiUrl = process.env.API_URL ?? 'http://api:3000';
const MONACO_CDN = 'https://cdn.jsdelivr.net';

const BASE_CSP =
  "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'";
const CONFIGS_CSP = `default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' ${MONACO_CDN}; style-src 'self' 'unsafe-inline' ${MONACO_CDN}; worker-src 'self' blob:; connect-src 'self' ${MONACO_CDN}`;

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: BASE_CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        source: '/servers/:id/configs',
        headers: [
          { key: 'Content-Security-Policy', value: CONFIGS_CSP },
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
