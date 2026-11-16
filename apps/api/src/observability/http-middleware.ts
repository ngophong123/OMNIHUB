import type { NextFunction, Request, Response } from 'express';
import { accessLogPath } from '../deployment-security';
import { apiLogger } from './logger';
import { getLogContext, resolveCorrelationId, runWithLogContext } from './request-context';

/**
 * Express middleware establishing per-request AsyncLocalStorage logging context,
 * validated X-Correlation-ID propagation, security response headers, Origin CSRF gating,
 * and structured HTTP access/security logging.
 */
export function createHttpSecurityLoggingMiddleware(origin: string, enableAccessLogs: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    const correlationId = resolveCorrelationId(req.get('x-correlation-id') ?? req.get('x-request-id'));
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const start = Date.now();
    runWithLogContext({ correlationId, service: 'omnihub-api', component: 'http' }, () => {
      const requestContext = getLogContext();
      if (enableAccessLogs) {
        res.on('finish', () => {
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
      }
      // All mutations (including /webhooks/* until HMAC/replay verification exists) remain strictly origin-gated.
      if ((req.get('origin') && req.get('origin') !== origin) || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== origin)) {
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
