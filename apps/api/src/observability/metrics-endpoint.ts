import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { apiLogger } from './logger';
import { apiMetrics, type MetricsCollector, type OutboxBacklogReader } from './metrics';
import { getLogContext } from './request-context';

export type MetricsEndpointOptions = {
  metrics?: MetricsCollector;
  backlogDb?: OutboxBacklogReader;
  authToken?: string | (() => string | undefined);
};

function sha256Buffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function isLoopbackAddress(rawIp?: string): boolean {
  if (!rawIp) return false;
  const trimmed = rawIp.trim();
  const normalized = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  if (normalized === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split('.').every(octet => {
      const n = Number(octet);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  return false;
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
 * Express handler exposing Prometheus exposition output on `/metrics`
 * behind strict Bearer token or unproxied loopback access control.
 */
export function createMetricsRequestHandler(options: MetricsEndpointOptions = {}): RequestHandler {
  const metrics = options.metrics ?? apiMetrics;
  const resolveToken =
    typeof options.authToken === 'function'
      ? options.authToken
      : options.authToken !== undefined
        ? () => options.authToken as string | undefined
        : () => process.env.METRICS_AUTH_TOKEN?.trim() || undefined;

  return async (req: Request, res: Response) => {
    const correlationId = res.getHeader('x-correlation-id') ?? getLogContext()?.correlationId;
    if (!isMetricsRequestAuthorized(req, resolveToken())) {
      apiLogger.security('warn', 'METRICS_ACCESS_DENIED', {
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
      apiLogger.ops('error', 'METRICS_RENDER_FAILED', {
        component: 'metrics',
        errorType: err instanceof Error ? err.name : typeof err,
        ...(correlationId ? { correlationId } : {}),
      });
      res.status(500).json({ code: 'METRICS_UNAVAILABLE', ...(correlationId ? { correlationId } : {}) });
    }
  };
}
