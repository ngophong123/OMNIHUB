import type { NextConfig } from 'next';

function buildCsp(): string {
  const apiRaw = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  let apiOrigin = 'http://localhost:4000';
  let wsOrigin = 'ws://localhost:4000';
  try {
    const parsed = new URL(apiRaw);
    apiOrigin = parsed.origin;
    wsOrigin = `${parsed.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsed.host}`;
  } catch {
    // Keep loopback defaults if NEXT_PUBLIC_API_URL is malformed at build time.
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin} ${wsOrigin}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ['@omnihub/contracts'],
  async headers() {
    const csp = buildCsp();
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
