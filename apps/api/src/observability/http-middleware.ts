import type { NextFunction, Request, Response } from 'express';
import { accessLogPath } from '../deployment-security';
import { apiLogger } from './logger';
import { apiMetrics, type MetricsCollector } from './metrics';
import { getLogContext, resolveCorrelationId, runWithLogContext } from './request-context';

/**
 * Express middleware establishing per-request AsyncLocalStorage logging context,
 * validated X-Correlation-ID propagation, security response headers, Origin CSRF gating,
 * bounded-cardinality HTTP Prometheus metrics, and structured HTTP access/security logging.
 */
export function createHttpSecurityLoggingMiddleware(
  origin: string,
  enableAccessLogs: boolean,
  metrics: MetricsCollector = apiMetrics,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const correlationId = resolveCorrelationId(req.get('x-correlation-id') ?? req.get('x-request-id'));
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const start = Date.now();
    const startNs = process.hrtime.bigint();
    const rawPath = (req.originalUrl ?? req.url ?? '/').split('?')[0] ?? '/';
    const isMetricsScrape = rawPath === '/metrics';
    const endInFlight = isMetricsScrape ? () => undefined : metrics.recordHttpRequestStart(req.method);

    runWithLogContext({ correlationId, service: 'omnihub-api', component: 'http' }, () => {
      const requestContext = getLogContext();
      res.on('close', () => {
        endInFlight();
      });
      res.on('finish', () => {
        endInFlight();
        if (!isMetricsScrape) {
          const routeObj = (req as Request & { route?: { path?: unknown } }).route;
          metrics.recordHttpRequest({
            method: req.method,
            routePath: routeObj?.path,
            originalUrl: req.originalUrl ?? req.url,
            statusCode: res.statusCode,
            durationSeconds: Number(process.hrtime.bigint() - startNs) / 1e9,
          });
        }
        if (!enableAccessLogs) return;
        const emitAccessLog = () =>
          apiLogger.app('info', 'HTTP_ACCESS', {
            method: req.method,
            path: accessLogPath(req.originalUrl),
            status: res.statusCode,
            durationMs: Date.now() - start,
            correlationId,
          });
        if (requestContext) {
          runWithLogContext(requestContext, emitAccessLog);
        } else {
          emitAccessLog();
        }
      });

      // All mutations (including /webhooks/* until HMAC/replay verification exists) remain strictly origin-gated.
      if ((req.get('origin') && req.get('origin') !== origin) || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== origin)) {
        metrics.recordHttpError({
          method: req.method,
          originalUrl: req.originalUrl ?? req.url,
          code: 'ORIGIN_DENIED',
        });
        apiLogger.security('warn', 'ORIGIN_DENIED', {
          method: req.method,
          path: accessLogPath(req.originalUrl),
          correlationId,
        });
        res.status(403).json({ code: 'ORIGIN_DENIED', correlationId });
        return;
      }
      next();
    });
  };
}
