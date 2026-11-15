import { describe, expect, it } from 'vitest';
import { accessLogPath, validateDeployment } from '../../apps/api/src/deployment-security';

const env = { NODE_ENV: 'production', WEB_ORIGIN: 'https://localhost:8443', SESSION_SECURE: 'true', QR_TOKEN_SECRET: 'a'.repeat(64), TRUSTED_PROXY_CIDRS: '172.29.87.2', REDIS_URL: `redis://app:${'b'.repeat(64)}@redis:6379`, DATABASE_URL: `postgresql://app:${'c'.repeat(64)}@postgres/db`, DATA_NETWORK_MODE: 'isolated-single-host' };
describe('deployment security boundary', () => {
  it('accepts explicit isolated single-host settings and requires TLS elsewhere', () => {
    expect(() => validateDeployment(env)).not.toThrow();
    expect(() => validateDeployment({ ...env, DATA_NETWORK_MODE: '' })).toThrow('POSTGRES_TLS');
    expect(() => validateDeployment({ ...env, DATA_NETWORK_MODE: '', DATABASE_URL: `${env.DATABASE_URL}?sslmode=verify-full`, REDIS_URL: env.REDIS_URL.replace('redis:', 'rediss:') })).not.toThrow();
  });
  it.each([
    ['WEB_ORIGIN', 'http://localhost:3000'], ['WEB_ORIGIN', 'https://example.test/path'],
    ['SESSION_SECURE', 'false'], ['QR_TOKEN_SECRET', 'short'],
    ['TRUSTED_PROXY_CIDRS', '0.0.0.0/0'], ['TRUSTED_PROXY_CIDRS', '::/0'], ['TRUSTED_PROXY_CIDRS', 'true'],
    ['REDIS_URL', 'redis://redis:6379'], ['DATABASE_URL', 'postgresql://app:weak@postgres/db'],
  ])('rejects unsafe %s without logging its value', (key, value) => {
    expect(() => validateDeployment({ ...env, [key]: value })).toThrow(`UNSAFE_DEPLOYMENT_${key}`);
  });
  it('redacts capability paths and all query values', () => {
    expect(accessLogPath('/public/qr/secret/menu?token=secret')).toBe('/public/qr/:credential/menu');
    expect(accessLogPath('/public/order-status/secret')).toBe('/public/order-status/:trackingToken');
    expect(accessLogPath('/public/invitations/secret/accept')).toBe('/public/invitations/:token/accept');
    expect(accessLogPath('/admin/tables/qr-code?token=secret')).toBe('/admin/tables/qr-code');
  });
  it('skips deployment gate outside production and validates IPv6/missing secrets in production', () => {
    expect(() => validateDeployment({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => validateDeployment({ ...env, WEB_ORIGIN: 'https://user:pass@localhost:8443' })).toThrow('UNSAFE_DEPLOYMENT_WEB_ORIGIN');
    expect(() => validateDeployment({ ...env, QR_TOKEN_SECRET: undefined })).toThrow('UNSAFE_DEPLOYMENT_QR_TOKEN_SECRET');
    expect(() => validateDeployment({ ...env, TRUSTED_PROXY_CIDRS: '' })).toThrow('UNSAFE_DEPLOYMENT_TRUSTED_PROXY_CIDRS');
    expect(() => validateDeployment({ ...env, TRUSTED_PROXY_CIDRS: '127.0.0.1/24' })).toThrow('UNSAFE_DEPLOYMENT_TRUSTED_PROXY_CIDRS');
    expect(() => validateDeployment({ ...env, TRUSTED_PROXY_CIDRS: '::1/128,127.0.0.1/32' })).not.toThrow();
    expect(() => validateDeployment({ ...env, DATA_NETWORK_MODE: '', DATABASE_URL: `${env.DATABASE_URL}?sslmode=verify-full` })).toThrow('REDIS_TLS');
  });
});
