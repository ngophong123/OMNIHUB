import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './http';
import { Errors } from './errors';
import { accessLogPath } from './deployment-security';

export type HttpAppOptions = {
  origin?: string;
  trustedProxies?: string[];
  enableAccessLogs?: boolean;
  configureBeforeFilters?: (app: INestApplication) => void;
};

/**
 * Creates the NestJS Express application with security headers, Origin CSRF gate,
 * CORS policy, cookie parsing, and the global sanitized Errors exception filter.
 */
export async function createConfiguredHttpApp(options: HttpAppOptions = {}): Promise<INestApplication> {
  const origin = options.origin ?? process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const enableAccessLogs = options.enableAccessLogs ?? true;
  // Operational request/error records below are JSON. The framework's default
  // startup logger writes unstructured route listings and is disabled in prod.
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production' || !enableAccessLogs ? false : undefined,
  });

  if (options.trustedProxies?.length) {
    app.getHttpAdapter().getInstance().set('trust proxy', options.trustedProxies);
  }

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: NextFunction) => {
    const correlationId = randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const start = Date.now();
    if (enableAccessLogs) {
      res.on('finish', () => {
        const path = accessLogPath(req.originalUrl);
        console.log(JSON.stringify({ level: 'info', method: req.method, path, status: res.statusCode, durationMs: Date.now() - start, correlationId }));
      });
    }
    // All mutations (including /webhooks/* until HMAC/replay verification exists) remain strictly origin-gated.
    if ((req.get('origin') && req.get('origin') !== origin) || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== origin)) {
      res.status(403).json({ code: 'ORIGIN_DENIED', correlationId });
      return;
    }
    next();
  });
  app.enableCors({
    origin,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'Authorization', 'X-Kitchen-Device', 'X-QR-Token'],
  });
  options.configureBeforeFilters?.(app);
  app.useGlobalFilters(new Errors());
  return app;
}
