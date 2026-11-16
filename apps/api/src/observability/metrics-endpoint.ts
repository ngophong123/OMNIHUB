import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator, type ClientRateLimitInfo, type IncrementResponse, type Options, type Store } from 'express-rate-limit';
import { digest } from '../domain';
import { apiLogger, type StructuredLogger } from './logger';
import { apiMetrics, type MetricsCollector, type OutboxBacklogReader } from './metrics';
import { getLogContext } from './request-context';

export const DEFAULT_METRICS_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_METRICS_RATE_LIMIT_MAX = 120;
export const DEFAULT_METRICS_RATE_LIMIT_MAX_ENTRIES = 1024;

export type MetricsEndpointOptions = {
  metrics?: MetricsCollector;
  backlogDb?: OutboxBacklogReader;
  authToken?: string | (() => string | undefined);
  logger?: StructuredLogger;
};

export type BoundedMemoryRateLimitStoreOptions = {
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
};

export type MetricsRateLimitConfigOptions = {
  store: BoundedMemoryRateLimitStore;
  windowMs?: number;
  limit?: number;
  logger?: StructuredLogger;
};

function sha256Buffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function configuredInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function resolveMetricsRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): { windowMs: number; limit: number; maxEntries: number } {
  return {
    windowMs: configuredInt(env.METRICS_RATE_LIMIT_WINDOW_MS, DEFAULT_METRICS_RATE_LIMIT_WINDOW_MS, 1_000, 3_600_000),
    limit: configuredInt(env.METRICS_RATE_LIMIT_MAX, DEFAULT_METRICS_RATE_LIMIT_MAX, 1, 10_000),
    maxEntries: configuredInt(env.METRICS_RATE_LIMIT_MAX_ENTRIES, DEFAULT_METRICS_RATE_LIMIT_MAX_ENTRIES, 16, 65_536),
  };
}

export function isLoopbackAddress(rawIp?: string): boolean {
  if (!rawIp) return false;
  const trimmed = rawIp.trim();
  const withoutZone = trimmed.includes('%') ? trimmed.slice(0, trimmed.indexOf('%')) : trimmed;
  const normalized = withoutZone.startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone;
  if (normalized === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split('.').every(octet => {
      const n = Number(octet);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  return false;
}

/**
 * Derives an opaque SHA-256 rate-limit key solely from the direct TCP peer address,
 * ignoring spoofable forwarding headers and normalizing IPv6 to /64 subnets.
 */
export function metricsRateLimitKey(req: Request): string {
  const raw = req.socket?.remoteAddress || req.ip || 'unknown';
  const trimmed = raw.trim();
  const withoutZone = trimmed.includes('%') ? trimmed.slice(0, trimmed.indexOf('%')) : trimmed;
  const mappedIpv4 = withoutZone.startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone;
  const normalized = isIP(mappedIpv4) ? ipKeyGenerator(mappedIpv4, 64) : 'unknown';
  return digest(`omnihub:metrics-rate-key:v1:${normalized}`);
}

export function isMetricsRequestAuthorized(req: Request, configuredToken?: string): boolean {
  if (configuredToken) {
    const header = req.get('authorization');
    if (!header || !header.startsWith('Bearer ')) return false;
    const candidate = header.slice(7).trim();
    if (!candidate) return false;
    return timingSafeEqual(sha256Buffer(candidate), sha256Buffer(configuredToken));
  }

  // Without an explicit scrape token, fail closed unless direct loopback with no proxy forwarding headers.
  if (req.get('x-forwarded-for') || req.get('forwarded') || req.get('x-real-ip')) {
    return false;
  }
  const socketIp = req.socket?.remoteAddress;
  const clientIp = req.ip ?? socketIp;
  return isLoopbackAddress(socketIp) && isLoopbackAddress(clientIp);
}

/**
 * Fixed-window rate limit Store with bounded LRU capacity, lazy expiry eviction,
 * zero background interval timers, and explicit shutdown cleanup.
 */
export class BoundedMemoryRateLimitStore implements Store {
  readonly localKeys = true;
  readonly prefix = 'omnihub:metrics-rate:';
  private windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { totalHits: number; resetAt: number }>();
  private closed = false;

  constructor(options: BoundedMemoryRateLimitStoreOptions = {}) {
    this.windowMs = options.windowMs && options.windowMs > 0 ? options.windowMs : DEFAULT_METRICS_RATE_LIMIT_WINDOW_MS;
    this.maxEntries = options.maxEntries && options.maxEntries > 0 ? options.maxEntries : DEFAULT_METRICS_RATE_LIMIT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  init(options: Options): void {
    if (options.windowMs > 0) {
      this.windowMs = options.windowMs;
    }
  }

  get(key: string): ClientRateLimitInfo | undefined {
    if (this.closed) return undefined;
    const existing = this.entries.get(key);
    if (!existing) return undefined;
    if (existing.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return { totalHits: existing.totalHits, resetTime: new Date(existing.resetAt) };
  }

  increment(key: string): IncrementResponse {
    const currentNow = this.now();
    if (this.closed) {
      return { totalHits: 1, resetTime: new Date(currentNow + this.windowMs) };
    }

    const existing = this.entries.get(key);
    if (existing && existing.resetAt > currentNow) {
      existing.totalHits++;
      // Refresh LRU insertion order on active key hits.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return { totalHits: existing.totalHits, resetTime: new Date(existing.resetAt) };
    }

    if (existing) {
      this.entries.delete(key);
    }

    if (this.entries.size >= this.maxEntries) {
      for (const [candidateKey, candidateValue] of this.entries) {
        if (candidateValue.resetAt <= currentNow) {
          this.entries.delete(candidateKey);
        }
      }
      while (this.entries.size >= this.maxEntries) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey === undefined) break;
        this.entries.delete(oldestKey);
      }
    }

    const fresh = { totalHits: 1, resetAt: currentNow + this.windowMs };
    this.entries.set(key, fresh);
    return { totalHits: 1, resetTime: new Date(fresh.resetAt) };
  }

  decrement(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    if (existing.totalHits <= 1) {
      this.entries.delete(key);
      return;
    }
    existing.totalHits--;
  }

  resetKey(key: string): void {
    this.entries.delete(key);
  }

  resetAll(): void {
    this.entries.clear();
  }

  shutdown(): void {
    this.closed = true;
    this.entries.clear();
  }
}

/**
 * Builds express-rate-limit options tailored for Prometheus `/metrics` scraping:
 * ignores spoofable forwarding headers, allows high scrape headroom (120/min default),
 * returns HTTP 429 + Retry-After on excess, and emits redacted security logs.
 */
export function buildMetricsRateLimitOptions(options: MetricsRateLimitConfigOptions): Partial<Options> {
  const defaults = resolveMetricsRateLimitConfig();
  const windowMs = options.windowMs ?? defaults.windowMs;
  const limit = options.limit ?? defaults.limit;
  const logger = options.logger ?? apiLogger;

  return {
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: false,
    store: options.store,
    keyGenerator: metricsRateLimitKey,
    validate: {
      xForwardedForHeader: false,
      forwardedHeader: false,
      keyGeneratorIpFallback: false,
    },
    handler: (req: Request, res: Response) => {
      const correlationId = res.getHeader('x-correlation-id') ?? getLogContext()?.correlationId;
      const rateLimitInfo = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
      const resetSeconds = rateLimitInfo?.resetTime
        ? Math.max(1, Math.ceil((rateLimitInfo.resetTime.getTime() - Date.now()) / 1000))
        : Math.max(1, Math.ceil(windowMs / 1000));
      if (!res.getHeader('Retry-After')) {
        res.setHeader('Retry-After', String(resetSeconds));
      }
      logger.security('warn', 'METRICS_RATE_LIMITED', {
        component: 'metrics',
        method: req.method,
        path: '/metrics',
        resetSeconds,
        ...(correlationId ? { correlationId } : {}),
      });
      res.status(429).json({ code: 'RATE_LIMITED', ...(correlationId ? { correlationId } : {}) });
    },
  };
}

export function createMetricsRateLimiter(options: MetricsRateLimitConfigOptions): RequestHandler {
  return rateLimit(buildMetricsRateLimitOptions(options));
}

/**
 * Express handler exposing Prometheus exposition output on `/metrics`
 * behind strict Bearer token or unproxied loopback access control.
 */
export function createMetricsRequestHandler(options: MetricsEndpointOptions = {}): RequestHandler {
  const metrics = options.metrics ?? apiMetrics;
  const logger = options.logger ?? apiLogger;
  const resolveToken =
    typeof options.authToken === 'function'
      ? options.authToken
      : options.authToken !== undefined
        ? () => options.authToken as string | undefined
        : () => process.env.METRICS_AUTH_TOKEN?.trim() || undefined;

  return async (req: Request, res: Response) => {
    const correlationId = res.getHeader('x-correlation-id') ?? getLogContext()?.correlationId;
    if (!isMetricsRequestAuthorized(req, resolveToken())) {
      logger.security('warn', 'METRICS_ACCESS_DENIED', {
        component: 'metrics',
        method: req.method,
        path: '/metrics',
        ...(correlationId ? { correlationId } : {}),
      });
      res.status(403).json({ code: 'METRICS_ACCESS_DENIED', ...(correlationId ? { correlationId } : {}) });
      return;
    }

    try {
      if (options.backlogDb) {
        await metrics.refreshOutboxBacklog(options.backlogDb);
      }

      const body = await metrics.render();
      res.status(200);
      res.setHeader('Content-Type', metrics.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(body);
    } catch (err) {
      logger.ops('error', 'METRICS_RENDER_FAILED', {
        component: 'metrics',
        errorType: err instanceof Error ? err.name : typeof err,
        ...(correlationId ? { correlationId } : {}),
      });
      res.status(500).json({ code: 'METRICS_UNAVAILABLE', ...(correlationId ? { correlationId } : {}) });
    }
  };
}
