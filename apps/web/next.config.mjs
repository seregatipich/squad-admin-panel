const apiUrl = process.env.API_URL ?? 'http://api:3000';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiUrl}/api/:path*` },
      { source: '/health', destination: `${apiUrl}/health` },
      { source: '/ready', destination: `${apiUrl}/ready` },
    ];
  },
  output: 'standalone',
};
