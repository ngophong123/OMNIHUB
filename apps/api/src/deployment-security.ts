import { isIP } from 'node:net';

/** Fail before listening; messages deliberately contain no configured values. */
export function validateDeployment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const fail = (name: string): never => { throw new Error(`UNSAFE_DEPLOYMENT_${name}`); };
  const url = (name: string) => { try { return new URL(env[name] ?? ''); } catch { return fail(name); } };
  const origin = url('WEB_ORIGIN');
  if (origin.protocol !== 'https:' || origin.origin !== env.WEB_ORIGIN || origin.username || origin.password) fail('WEB_ORIGIN');
  if (env.SESSION_SECURE !== 'true') fail('SESSION_SECURE');
  if (!env.QR_TOKEN_SECRET || env.QR_TOKEN_SECRET.length < 64) fail('QR_TOKEN_SECRET');
  const proxies = env.TRUSTED_PROXY_CIDRS?.split(',').map(value => value.trim());
  if (!proxies?.length || proxies.some(value => {
    const [address, prefix] = value.split('/');
    const family = isIP(address ?? '');
    return !family || (prefix !== undefined && Number(prefix) !== (family === 4 ? 32 : 128));
  })) fail('TRUSTED_PROXY_CIDRS');
  const redis = url('REDIS_URL');
  if (!['redis:', 'rediss:'].includes(redis.protocol) || !redis.username || redis.password.length < 32) fail('REDIS_URL');
  const postgres = url('DATABASE_URL');
  if (!['postgres:', 'postgresql:'].includes(postgres.protocol) || !postgres.username || postgres.password.length < 32) fail('DATABASE_URL');
  // Explicit opt-in only for a single-host private container network. Cross-host
  // PostgreSQL requires certificate verification; Redis requires TLS as well.
  if (env.DATA_NETWORK_MODE !== 'isolated-single-host') {
    if (postgres.searchParams.get('sslmode') !== 'verify-full') fail('POSTGRES_TLS');
    if (redis.protocol !== 'rediss:') fail('REDIS_TLS');
  }
}

export function accessLogPath(originalUrl: string): string {
  const path = originalUrl.split('?')[0] ?? '/';
  return path.replace(/^\/public\/qr\/[^/]+/i, '/public/qr/:credential')
    .replace(/^\/public\/order-status\/[^/]+/i, '/public/order-status/:trackingToken')
    .replace(/^\/public\/invitations\/[^/]+/i, '/public/invitations/:token');
}
