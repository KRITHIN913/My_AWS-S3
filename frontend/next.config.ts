// next.config.ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  async rewrites() {
    // In production, proxy /api/* to backend to avoid CORS entirely
    // In dev, the CORS plugin on the backend handles cross-origin requests
    return process.env.NODE_ENV === 'production'
      ? [{ source: '/api/:path*', destination: `${process.env['API_URL'] ?? 'http://localhost:3000'}/:path*` }]
      : [];
  },
};

export default config;
