import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './http';
import { Errors } from './errors';
import { createHttpSecurityLoggingMiddleware } from './observability/http-middleware';

export type HttpAppOptions = {
  origin?: string;
  trustedProxies?: string[];
  enableAccessLogs?: boolean;
  configureBeforeFilters?: (app: INestApplication) => void;
};

export { createHttpSecurityLoggingMiddleware };

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
  app.use(createHttpSecurityLoggingMiddleware(origin, enableAccessLogs));
  app.enableCors({
    origin,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'Authorization', 'X-Kitchen-Device', 'X-QR-Token'],
  });
  options.configureBeforeFilters?.(app);
  app.useGlobalFilters(new Errors());
  return app;
}
